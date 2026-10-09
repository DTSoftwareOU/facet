package io.dtsoftware.facet.ui.settings

import android.content.Context
import android.net.Uri
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Writes a portable JSON export of the user's data (API keys excluded). */
object DataExport {
    suspend fun writeAll(container: AppContainer, context: Context, uri: Uri) = withContext(Dispatchers.IO) {
        val conversations = container.db.conversations().all()
        val json = buildJsonObject {
            put("format", "facet-export")
            put("version", 1)
            put("app", BuildConfig.VERSION_NAME)
            put("exportedAt", Clock.now())
            put(
                "conversations",
                buildJsonArray {
                    conversations.forEach { conv ->
                        val messages = container.db.messages().forConversation(conv.id)
                        add(
                            buildJsonObject {
                                put("id", conv.id)
                                put("title", conv.title)
                                put("createdAt", conv.createdAt)
                                put("model", conv.modelId ?: "")
                                put("archived", conv.archived)
                                put("pinned", conv.pinned)
                                conv.systemPrompt?.let { put("instructions", it) }
                                put(
                                    "messages",
                                    JsonArray(
                                        messages.map { m ->
                                            buildJsonObject {
                                                put("id", m.id)
                                                m.parentId?.let { put("parentId", it) }
                                                put("role", m.role)
                                                put("content", m.content)
                                                m.thinking?.let { put("reasoning", it) }
                                                m.modelId?.let { put("model", it) }
                                                put("createdAt", m.createdAt)
                                                m.costUsd?.let { put("costUsd", it) }
                                                m.attachmentsJson?.let { put("attachments", AppJson.parseToJsonElement(it)) }
                                            }
                                        },
                                    ),
                                )
                            },
                        )
                    }
                },
            )
            put(
                "assistants",
                JsonArray(
                    container.assistants.observeAll().first().filterNot { it.builtin }.map { a ->
                        buildJsonObject {
                            put("name", a.name)
                            put("emoji", a.emoji ?: "")
                            put("instructions", a.instructions)
                            put("starters", JsonArray(a.starters.map { JsonPrimitive(it) }))
                        }
                    },
                ),
            )
            put(
                "prompts",
                JsonArray(container.prompts.observeAll().first().map { p -> buildJsonObject { put("title", p.title); put("body", p.body) } }),
            )
            val synced = container.settings.synced.value
            put("customInstructions", buildJsonObject { put("aboutMe", synced.aboutMe); put("responseStyle", synced.responseStyle) })
        }
        context.contentResolver.openOutputStream(uri)?.use { out ->
            out.write(AppJson.encodeToString(JsonObject.serializer(), json).toByteArray())
        } ?: error("Couldn't open the file for writing")
    }
}
