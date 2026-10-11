package io.dtsoftware.facet.data

import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import io.dtsoftware.facet.data.db.FacetDatabase
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A database from the previous version (built from its exported schema) opens with its data after the auto-migration. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class DatabaseMigrationTest {
    private fun schema(version: Int): JsonObject =
        Json.parseToJsonElement(File("schemas/io.dtsoftware.facet.data.db.FacetDatabase/$version.json").readText()).jsonObject["database"]!!.jsonObject

    /** Creates a database exactly as Room would have at [version]. */
    private fun create(file: File, version: Int) {
        val s = schema(version)
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            for (e in s["entities"]!!.jsonArray.map { it.jsonObject }) {
                val table = e["tableName"]!!.jsonPrimitive.content
                db.execSQL(e["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                e["indices"]?.jsonArray?.forEach { db.execSQL(it.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table)) }
                e["contentSyncTriggers"]?.jsonArray?.forEach { db.execSQL(it.jsonPrimitive.content) }
            }
            s["setupQueries"]!!.jsonArray.forEach { db.execSQL(it.jsonPrimitive.content) }
            db.execSQL(
                "INSERT INTO conversations (id, title, titleSet, paramsJson, pinned, archived, createdAt, lastActivityAt, updatedAt, deleted, dirty) " +
                    "VALUES ('c1', 'Before the update', 1, '{}', 0, 0, 1, 2, 3, 0, 0)",
            )
            db.version = version
        }
    }

    @Test
    fun version4OpensAsVersion5WithItsChats() = runBlocking {
        val ctx = RuntimeEnvironment.getApplication()
        val file = ctx.getDatabasePath("migration-test.db").apply { parentFile?.mkdirs(); delete() }
        create(file, 4)
        val db = Room.databaseBuilder(ctx, FacetDatabase::class.java, file.absolutePath).allowMainThreadQueries().build()
        try {
            val c = db.conversations().get("c1")!!
            assertEquals("Before the update", c.title)
            assertNull(c.computerHost)
            assertNull(c.computerFolder)
            db.conversations().upsert(c.copy(computerHost = "host-1", computerFolder = "C:\\Users\\alex\\app"))
            assertEquals("C:\\Users\\alex\\app", db.conversations().get("c1")!!.computerFolder)
            assertEquals(5, db.openHelper.readableDatabase.version)
        } finally {
            db.close()
        }
    }
}
