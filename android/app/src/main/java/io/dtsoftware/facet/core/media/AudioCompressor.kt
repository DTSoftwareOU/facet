package io.dtsoftware.facet.core.media

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Shrinks uncompressed audio before it's stored and synced. */
object AudioCompressor {
    private data class Wav(val sampleRate: Int, val channels: Int, val bits: Int, val dataOffset: Int, val dataLength: Int)

    /**
     * 16-bit PCM WAV → AAC-LC in an .m4a container with the device's encoder (about a tenth of the size
     * for speech). Null when the input isn't 16-bit PCM, the device can't encode it, or it wouldn't be smaller.
     */
    fun wavToM4a(wav: ByteArray, tmpDir: File, bitrate: Int = 64_000): ByteArray? {
        val info = parseWav(wav)?.takeIf { it.bits == 16 && it.channels in 1..2 && it.sampleRate in 8_000..48_000 } ?: return null
        val out = runCatching { File.createTempFile("facet-aac", ".m4a", tmpDir) }.getOrNull() ?: return null
        var codec: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var muxing = false
        return try {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, info.sampleRate, info.channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
            }
            val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).also { codec = it }
            c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            c.start()
            val m = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also { muxer = it }
            var track = -1
            val bufInfo = MediaCodec.BufferInfo()
            val frame = info.channels * 2
            val end = info.dataOffset + info.dataLength
            var offset = info.dataOffset
            var timeUs = 0L
            var inputDone = false
            var outputDone = false
            var spins = 0
            while (!outputDone) {
                if (++spins > 200_000) return null // a stuck codec must not hang the reply
                if (!inputDone) {
                    val inIdx = c.dequeueInputBuffer(5_000)
                    if (inIdx >= 0) {
                        val buf = c.getInputBuffer(inIdx) ?: return null
                        buf.clear()
                        val n = minOf(buf.remaining(), end - offset) / frame * frame
                        if (n <= 0) {
                            c.queueInputBuffer(inIdx, 0, 0, timeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            buf.put(wav, offset, n)
                            c.queueInputBuffer(inIdx, 0, n, timeUs, 0)
                            timeUs += (n / frame) * 1_000_000L / info.sampleRate
                            offset += n
                        }
                    }
                }
                val outIdx = c.dequeueOutputBuffer(bufInfo, 5_000)
                if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = m.addTrack(c.outputFormat)
                    m.start()
                    muxing = true
                } else if (outIdx >= 0) {
                    val ob = c.getOutputBuffer(outIdx)
                    if (bufInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bufInfo.size = 0
                    if (ob != null && bufInfo.size > 0 && muxing) {
                        ob.position(bufInfo.offset)
                        ob.limit(bufInfo.offset + bufInfo.size)
                        m.writeSampleData(track, ob, bufInfo)
                    }
                    c.releaseOutputBuffer(outIdx, false)
                    if (bufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                }
            }
            c.stop()
            if (muxing) m.stop()
            muxing = false
            m.release()
            muxer = null
            out.readBytes().takeIf { it.isNotEmpty() && it.size < wav.size }
        } catch (e: Exception) {
            null
        } finally {
            runCatching { codec?.release() }
            runCatching { if (muxing) muxer?.stop() }
            runCatching { muxer?.release() }
            out.delete()
        }
    }

    private fun parseWav(b: ByteArray): Wav? {
        if (b.size < 44 || String(b, 0, 4, Charsets.US_ASCII) != "RIFF" || String(b, 8, 4, Charsets.US_ASCII) != "WAVE") return null
        val le = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
        var pos = 12
        var rate = 0
        var channels = 0
        var bits = 0
        while (pos + 8 <= b.size) {
            val id = String(b, pos, 4, Charsets.US_ASCII)
            val len = le.getInt(pos + 4)
            if (len < 0) return null
            val body = pos + 8
            when (id) {
                "fmt " -> {
                    if (len < 16 || body + 16 > b.size || le.getShort(body).toInt() != 1) return null // PCM only
                    channels = le.getShort(body + 2).toInt()
                    rate = le.getInt(body + 4)
                    bits = le.getShort(body + 14).toInt()
                }
                "data" -> {
                    if (rate == 0) return null
                    return Wav(rate, channels, bits, body, minOf(len, b.size - body))
                }
            }
            pos = body + len + (len and 1)
        }
        return null
    }
}
