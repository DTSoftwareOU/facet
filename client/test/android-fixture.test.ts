/**
 * Writes records encrypted by this client (one of every type) for the Android app's
 * WebRecordsCompatTest, which decodes them with the Kotlin RecordCodec. Regenerate with
 * `FACET_WRITE_FIXTURE=1 npx vitest run test/android-fixture.test.ts` after changing a payload.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { b64, unb64, utf8 } from '../src/core/bytes';
import { Vault } from '../src/core/crypto';
import { defaultSynced } from '../src/data/prefs';
import { defaultParams } from '../src/llm/types';
import { RecordCodec } from '../src/sync/codec';

const VAULT_HEX = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const OUT = join(__dirname, '../../android/app/src/test/resources/web-records.json');
const secrets = { seal: async (p: Uint8Array) => 'v1:' + b64(p), open: async (s: string) => unb64(s.slice(3)) };
const base = { createdAt: 1767225600000, updatedAt: 1767225700000, deleted: 0 as const, dirty: 1 as const };

describe('Android compatibility fixture', () => {
  it('encodes one record of every type', async () => {
    const vault = await Vault.open(new Uint8Array(VAULT_HEX.match(/../g)!.map((h) => parseInt(h, 16))));
    const codec = new RecordCodec(vault, secrets);
    const records = [
      await codec.encodeConversation({
        ...base, id: 'c1', title: 'Web chat', titleSet: true, assistantId: 'builtin.code', folderId: null, providerId: 'p1', modelId: 'claude-opus-5-5',
        paramsJson: JSON.stringify(defaultParams({ effort: 'HIGH', webSearch: true, temperature: 0.7 })), systemPrompt: null, currentLeafId: 'm2',
        pinned: true, archived: 0, lastActivityAt: 1767225650000, workspace: 'C:\\never\\synced',
      }),
      await codec.encodeMessage({
        ...base, id: 'm2', conversationId: 'c1', parentId: 'm1', role: 'assistant', content: 'Hello from the web', thinking: 'Thinking…', thinkingMs: 1200,
        blocksJson: JSON.stringify({ style: 'ANTHROPIC', model: 'claude-opus-5-5', json: '[]' }), attachmentsJson: null, citationsJson: JSON.stringify([{ url: 'https://example.com', title: 'Example' }]),
        providerId: 'p1', modelId: 'claude-opus-5-5', modelName: 'Claude Opus 5.5', status: 'DONE', errorJson: null,
        usageJson: JSON.stringify({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 2 }), costUsd: 0.0012,
        stepsJson: JSON.stringify({ steps: [{ text: '', calls: [{ id: 't1', name: 'run_command', kind: 'COMPUTER', label: 'Ran `dir`', argumentsJson: '{"command":"dir"}', result: 'ok', isError: false, durationMs: 40, serverName: 'Computer' }] }], finalText: 'Hello from the web' }),
      }),
      await codec.encodeAttachment({ ...base, id: 'a1', conversationId: 'c1', kind: 'image', mimeType: 'image/png', name: 'pic.png', sizeBytes: 1234, width: 10, height: 20, hasFile: 1, uploaded: true, localOnly: false }),
      await codec.encodeAssistant({ ...base, id: 's1', name: 'Chef', emoji: '🍳', colorIndex: 2, instructions: 'Cook.', providerId: null, modelId: null, paramsJson: null, startersJson: '["Pasta?"]', sort: 100 }),
      await codec.encodeFolder({ ...base, id: 'f1', name: 'Work', colorIndex: 1, sort: 0 }),
      await codec.encodePrompt({ ...base, id: 'q1', title: 'Summarize', body: 'Summarize this:' }),
      await codec.encodeProvider({
        ...base, id: 'p1', kind: 'anthropic', label: 'Personal', baseUrl: 'https://api.anthropic.com', apiKeySealed: await secrets.seal(utf8('sk-ant-web')),
        headersJson: '{}', enabled: true, modelsJson: '[]', modelsFetchedAt: 0, favoritesJson: '["claude-opus-5-5"]', customModelsJson: '[]', capsOverridesJson: '{}',
        modelPrefsJson: '{"claude-opus-5-5":{"name":"Opus","hidden":false}}', sort: 0,
      }),
      await codec.encodeMcp({
        ...base, id: 'x1', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', authMode: 'HEADERS', headersSealed: await secrets.seal(utf8('{"X-Key":"abc"}')),
        oauthSealed: '', enabled: true, approval: 'WRITES', toolsJson: '[]', toolsFetchedAt: 0, disabledToolsJson: '[]', autoApprovedJson: '["read_wiki"]', sort: 0,
      }),
      await codec.encodeSkill({ ...base, id: 'k1', name: 'notes', description: 'Meeting notes', instructions: 'Write notes.', resourcesJson: '[{"path":"a.md","content":"x"}]', enabled: true, alwaysOn: false, sourceUrl: null }),
      await codec.encodeSettings({ ...defaultSynced(), profileName: 'Ada', yoloMode: true, autoFreeSpace: false, defaultModel: { providerId: 'p1', modelId: 'claude-opus-5-5' }, updatedAt: 1767225800000 }),
      await codec.encodeConversation({ ...base, id: 'c2', deleted: 1, title: '', titleSet: false, paramsJson: '{}', pinned: false, archived: 0, lastActivityAt: 0 }),
    ];
    // Round-trips through this client's own decoder.
    for (const r of records) expect(await codec.open(r)).not.toBeNull();
    if (process.env.FACET_WRITE_FIXTURE || !existsSync(OUT)) {
      writeFileSync(OUT, JSON.stringify({ vaultKeyHex: VAULT_HEX, records }, null, 2) + '\n');
    }
  });
});
