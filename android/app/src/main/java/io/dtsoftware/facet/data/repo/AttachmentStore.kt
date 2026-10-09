package io.dtsoftware.facet.data.repo

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import android.util.LruCache
import android.webkit.MimeTypeMap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.FacetDatabase
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AttachmentException(message: String) : Exception(message)

/**
 * Imports, stores and loads attachments. Images are downscaled (longest edge ≤ 1600 px),
 * re-encoded (stripping EXIF/location data) and orientation-corrected before they're stored.
 */
class AttachmentStore(
    private val context: Context,
    private val db: FacetDatabase,
    private val onLocalChange: () -> Unit,
) {
    private val dao = db.attachments()
    val dir: File = File(context.filesDir, "attachments").apply { mkdirs() }
    private val thumbs = object : LruCache<String, ImageBitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    suspend fun import(uri: Uri): AttachmentEntity = withContext(Dispatchers.IO) {
        val cr = context.contentResolver
        var name = "file"
        var declaredSize = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) declaredSize = c.getLong(1)
            }
        }
        val ext = name.substringAfterLast('.', "").lowercase()
        val mime = cr.getType(uri)
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: if (ext in TEXT_EXTENSIONS) "text/plain" else "application/octet-stream"
        when {
            mime.startsWith("image/") && mime != "image/svg+xml" -> importImage(uri, name)
            mime == "application/pdf" -> importRaw(uri, name, mime, "pdf", MAX_PDF, declaredSize)
            mime.startsWith("text/") || ext in TEXT_EXTENSIONS || mime in TEXT_MIMES ->
                importRaw(uri, name, "text/plain", "text", MAX_TEXT, declaredSize)
            else -> throw AttachmentException("Facet can attach images, PDFs and text files. \"$name\" isn't one of those.")
        }
    }

    private suspend fun importImage(uri: Uri, name: String): AttachmentEntity {
        val cr = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0) throw AttachmentException("That image couldn't be read.")
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= MAX_EDGE && bounds.outHeight / (sample * 2) >= MAX_EDGE) sample *= 2
        val decoded = cr.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: throw AttachmentException("That image couldn't be read.")
        val orientation = runCatching {
            cr.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
        val rotated = applyOrientation(decoded, orientation)
        val scale = minOf(1f, MAX_EDGE.toFloat() / maxOf(rotated.width, rotated.height))
        val bmp = if (scale < 1f) {
            Bitmap.createScaledBitmap(rotated, (rotated.width * scale).toInt(), (rotated.height * scale).toInt(), true)
        } else {
            rotated
        }
        val png = bmp.hasAlpha() && (bounds.outMimeType == "image/png" || bounds.outMimeType == "image/webp")
        val out = ByteArrayOutputStream()
        bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 85, out)
        val bytes = out.toByteArray()
        val id = Ids.new()
        val fileName = "$id.${if (png) "png" else "jpg"}"
        File(dir, fileName).writeBytes(bytes)
        val now = Clock.now()
        val entity = AttachmentEntity(
            id = id,
            kind = "image",
            mimeType = if (png) "image/png" else "image/jpeg",
            name = name.substringBeforeLast('.') + if (png) ".png" else ".jpg",
            sizeBytes = bytes.size.toLong(),
            width = bmp.width,
            height = bmp.height,
            localFile = fileName,
            createdAt = now,
            updatedAt = now,
            dirty = false,
        )
        dao.upsert(entity)
        if (bmp !== rotated) bmp.recycle()
        if (rotated !== decoded) rotated.recycle()
        decoded.recycle()
        return entity
    }

    private suspend fun importRaw(uri: Uri, name: String, mime: String, kind: String, max: Long, declared: Long): AttachmentEntity {
        if (declared > max) throw AttachmentException("\"$name\" is larger than ${max / (1024 * 1024)} MB.")
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val buf = ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(chunk)
                if (n < 0) break
                total += n
                if (total > max) throw AttachmentException("\"$name\" is larger than ${max / (1024 * 1024)} MB.")
                buf.write(chunk, 0, n)
            }
            buf.toByteArray()
        } ?: throw AttachmentException("\"$name\" couldn't be read.")
        val id = Ids.new()
        val fileName = "$id.${if (kind == "pdf") "pdf" else "txt"}"
        File(dir, fileName).writeBytes(bytes)
        val now = Clock.now()
        val entity = AttachmentEntity(
            id = id, kind = kind, mimeType = mime, name = name, sizeBytes = bytes.size.toLong(),
            localFile = fileName, createdAt = now, updatedAt = now, dirty = false,
        )
        dao.upsert(entity)
        return entity
    }

    private fun applyOrientation(bmp: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.preScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.preScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.preScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.preScale(-1f, 1f) }
            else -> return bmp
        }
        return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    }

    /** Links draft attachments to the conversation they were sent in and queues them for sync. */
    suspend fun commit(ids: List<String>, conversationId: String) {
        val now = Clock.now()
        dao.getAll(ids).forEach { dao.upsert(it.copy(conversationId = conversationId, updatedAt = now, dirty = true)) }
        onLocalChange()
    }

    suspend fun discardDraft(id: String) = withContext(Dispatchers.IO) {
        val a = dao.get(id) ?: return@withContext
        if (a.conversationId == null) {
            a.localFile?.let { File(dir, it).delete() }
            dao.hardDelete(id)
        }
    }

    suspend fun get(id: String): AttachmentEntity? = dao.get(id)

    fun file(a: AttachmentEntity): File? = a.localFile?.let { File(dir, it) }?.takeIf { it.exists() }

    suspend fun bytes(id: String): ByteArray? = withContext(Dispatchers.IO) {
        dao.get(id)?.let { file(it)?.readBytes() }
    }

    suspend fun thumbnail(id: String, maxPx: Int): ImageBitmap? = withContext(Dispatchers.IO) {
        val key = "$id@$maxPx"
        thumbs.get(key)?.let { return@withContext it }
        val a = dao.get(id) ?: return@withContext null
        val f = file(a) ?: return@withContext null
        if (a.kind == "video") return@withContext videoFrame(f, maxPx)?.also { thumbs.put(key, it) }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxPx && bounds.outHeight / (sample * 2) >= maxPx) sample *= 2
        val bmp = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@withContext null
        bmp.asImageBitmap().also { thumbs.put(key, it) }
    }

    private fun videoFrame(f: File, maxPx: Int): ImageBitmap? = runCatching {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(f.path)
            val frame = r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: return null
            val scale = minOf(1f, maxPx.toFloat() / maxOf(frame.width, frame.height))
            val sized = if (scale < 1f) Bitmap.createScaledBitmap(frame, (frame.width * scale).toInt(), (frame.height * scale).toInt(), true) else frame
            if (sized !== frame) frame.recycle()
            sized.asImageBitmap()
        } finally {
            r.release()
        }
    }.getOrNull()

    /** Length of an audio or video attachment in milliseconds, if it can be read. */
    suspend fun durationMs(id: String): Long? = withContext(Dispatchers.IO) {
        val f = dao.get(id)?.let { file(it) } ?: return@withContext null
        runCatching {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(f.path)
                r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            } finally {
                r.release()
            }
        }.getOrNull()
    }

    /**
     * Saves a generated image, video or audio file as a conversation attachment, queued for
     * end-to-end encrypted sync like any other attachment.
     */
    suspend fun storeGenerated(bytes: ByteArray, mimeType: String, name: String, conversationId: String): AttachmentEntity = withContext(Dispatchers.IO) {
        val kind = when {
            mimeType.startsWith("image/") -> "image"
            mimeType.startsWith("video/") -> "video"
            mimeType.startsWith("audio/") -> "audio"
            else -> "file"
        }
        val id = Ids.new()
        val fileName = "$id.${io.dtsoftware.facet.llm.media.MediaGen.extensionFor(mimeType)}"
        File(dir, fileName).writeBytes(bytes)
        var w: Int? = null
        var h: Int? = null
        // Dimensions are best effort: an unreadable header only costs the layout hint.
        if (kind == "image") {
            runCatching {
                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
                if (o.outWidth > 0) { w = o.outWidth; h = o.outHeight }
            }
        } else if (kind == "video") {
            runCatching {
                val r = MediaMetadataRetriever()
                try {
                    r.setDataSource(File(dir, fileName).path)
                    w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
                    h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
                } finally {
                    r.release()
                }
            }
        }
        val now = Clock.now()
        val entity = AttachmentEntity(
            id = id, conversationId = conversationId, kind = kind, mimeType = mimeType, name = name,
            sizeBytes = bytes.size.toLong(), width = w, height = h, localFile = fileName,
            createdAt = now, updatedAt = now, dirty = true,
        )
        dao.upsert(entity)
        onLocalChange()
        entity
    }

    /** Stores bytes downloaded from the sync server for an attachment record. */
    suspend fun storeDownloaded(a: AttachmentEntity, bytes: ByteArray) = withContext(Dispatchers.IO) {
        val ext = when (a.kind) {
            "pdf" -> "pdf"
            "text", "file" -> "txt"
            else -> io.dtsoftware.facet.llm.media.MediaGen.extensionFor(a.mimeType).takeIf { it != "bin" } ?: if (a.kind == "image") "jpg" else "bin"
        }
        val fileName = "${a.id}.$ext"
        File(dir, fileName).writeBytes(bytes)
        dao.setLocalFile(a.id, fileName)
    }

    suspend fun deleteFile(a: AttachmentEntity) = withContext(Dispatchers.IO) {
        a.localFile?.let { File(dir, it).delete() }
    }

    suspend fun clearAll() = withContext(Dispatchers.IO) {
        dir.listFiles()?.forEach { it.delete() }
        thumbs.evictAll()
    }

    companion object {
        const val MAX_EDGE = 1600
        const val MAX_PDF = 32L * 1024 * 1024
        const val MAX_TEXT = 2L * 1024 * 1024
        val TEXT_EXTENSIONS = setOf(
            "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
            "kt", "kts", "java", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "go", "rs", "c", "h", "cpp", "hpp", "cc", "cs",
            "swift", "rb", "php", "sql", "sh", "bash", "zsh", "ps1", "html", "htm", "css", "scss", "dart", "lua", "r", "m",
            "gradle", "properties", "env", "tex", "srt", "vtt",
        )
        val TEXT_MIMES = setOf("application/json", "application/xml", "application/x-yaml", "application/javascript", "application/x-sh")

        fun ref(a: AttachmentEntity) = AttachmentRef(a.id, a.kind, a.mimeType, a.name, a.sizeBytes, a.width, a.height)
    }
}
