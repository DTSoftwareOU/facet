package io.dtsoftware.facet.sync

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.data.db.AttachmentEntity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a pulled attachment record changes this device's "kept on this device only" state. */
class AttachmentSyncStateTest {
    private val box = object : SecretBox {
        override fun seal(plain: ByteArray) = FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed)
    }
    private val codec = RecordCodec(ByteArray(32) { it.toByte() }, box)

    private fun local(uploaded: Boolean, localOnly: Boolean, file: String?) = AttachmentEntity(
        "a1", "c1", "audio", "audio/mpeg", "song.mp3", 10, localFile = file, uploaded = uploaded, localOnly = localOnly,
        createdAt = 1, updatedAt = 1, dirty = false,
    )

    private fun pulled(uploaded: Boolean): OpenedRecord =
        codec.open(codec.encode(local(uploaded, false, null).copy(updatedAt = 2)))!!

    @Test
    fun downloadedCopyBecomesDeviceOnlyWhenAnotherDeviceClearsTheCloudCopy() {
        assertTrue(codec.attachment(pulled(uploaded = false), local(uploaded = true, localOnly = false, file = "a1.mp3")).localOnly)
    }

    @Test
    fun withoutACopyThereIsNothingToKeep() {
        assertFalse(codec.attachment(pulled(uploaded = false), local(uploaded = true, localOnly = false, file = null)).localOnly)
    }

    @Test
    fun ownFileWaitingForSpaceKeepsWaiting() {
        // Its own "not uploaded" record coming back must not turn a waiting upload into a device-only file.
        assertFalse(codec.attachment(pulled(uploaded = false), local(uploaded = false, localOnly = false, file = "a1.mp3")).localOnly)
    }

    @Test
    fun deviceOnlyLastsUntilSomeDeviceUploadsIt() {
        assertTrue(codec.attachment(pulled(uploaded = false), local(uploaded = false, localOnly = true, file = "a1.mp3")).localOnly)
        assertFalse(codec.attachment(pulled(uploaded = true), local(uploaded = false, localOnly = true, file = "a1.mp3")).localOnly)
    }
}
