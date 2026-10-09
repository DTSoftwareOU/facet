package io.dtsoftware.facet.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        ConversationEntity::class,
        MessageEntity::class,
        MessageFts::class,
        AttachmentEntity::class,
        AssistantEntity::class,
        FolderEntity::class,
        PromptEntity::class,
        ProviderEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class FacetDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun messages(): MessageDao
    abstract fun attachments(): AttachmentDao
    abstract fun assistants(): AssistantDao
    abstract fun folders(): FolderDao
    abstract fun prompts(): PromptDao
    abstract fun providers(): ProviderDao

    companion object {
        fun create(context: Context): FacetDatabase =
            Room.databaseBuilder(context, FacetDatabase::class.java, "facet.db")
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .build()
    }
}
