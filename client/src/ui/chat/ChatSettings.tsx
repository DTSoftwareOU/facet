import { useLiveQuery } from 'dexie-react-hooks';
import { Brain, FolderOpen, Gem as GemIcon, Globe, Monitor, Rocket, Server, Wand2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import { parseJson } from '../../core/json';
import { db } from '../../data/db';
import { EFFORT_INFO, VERBOSITY_INFO, type Effort, type GenParams, type Verbosity } from '../../llm/types';
import { platform } from '../../platform';
import { isSearchKind } from '../../tools/types';
import { ProviderBadge } from '../components/Avatars';
import { Button, Dialog, Divider, Field, Group, Row, SwitchRow, useToast } from '../components/primitives';
import { useLocalPrefs, useSyncedPrefs } from '../hooks';
import type { ResolvedModel } from './ModelPicker';

export function Segmented<T>({ options, selected, label, onSelect }: { options: T[]; selected: T; label: (t: T) => string; onSelect: (t: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o, i) => (
        <button key={i} type="button" role="radio" aria-checked={o === selected} className={o === selected ? 'on' : ''} onClick={() => onSelect(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  );
}

export function effortHint(e: Effort | null | undefined): string {
  switch (e) {
    case null:
    case undefined:
      return 'The model decides how long to think.';
    case 'NONE':
      return 'Answers immediately without extended reasoning.';
    case 'MINIMAL':
    case 'LOW':
      return 'Quick answers for simple questions. Cheapest.';
    case 'MEDIUM':
      return 'Balanced depth, speed and cost.';
    case 'HIGH':
      return 'Thinks longer for harder problems.';
    default:
      return 'Maximum depth for the hardest problems. Slowest and most expensive.';
  }
}

/** Per-chat model parameters, tools and instructions (the chat settings sheet on Android). */
export function ChatSettings({ model, params, onParams, systemPrompt, onSystemPrompt, workspace, onWorkspace, onChangeModel, onClose }: {
  model: ResolvedModel | null;
  params: GenParams;
  onParams: (p: GenParams) => void;
  systemPrompt: string | null;
  onSystemPrompt: ((s: string | null) => void) | null;
  workspace: string | null;
  onWorkspace: ((path: string) => void) | null;
  onChangeModel: () => void;
  onClose: () => void;
}) {
  const app = getApp();
  const toast = useToast();
  const synced = useSyncedPrefs();
  const local = useLocalPrefs();
  const caps = model?.model.caps;
  const [instructions, setInstructions] = useState(systemPrompt ?? '');
  const servers = useLiveQuery(() => db().mcpServers.filter((s) => s.deleted === 0 && s.enabled).toArray(), []) ?? [];
  const skillCount = useLiveQuery(() => db().skills.filter((s) => s.deleted === 0 && s.enabled).count(), []) ?? 0;
  const searchAvailable = useLiveQuery(async () => (await db().providers.filter((p) => p.deleted === 0 && p.enabled && isSearchKind(p.kind)).count()) > 0, []) ?? false;
  const computer = platform().computer;

  const close = () => {
    if (onSystemPrompt && instructions !== (systemPrompt ?? '')) onSystemPrompt(instructions.trim() ? instructions : null);
    onClose();
  };
  useEffect(() => setInstructions(systemPrompt ?? ''), [systemPrompt]);

  const canSearch = !!caps && (caps.webSearch || (caps.tools && searchAvailable));
  const set = (patch: Partial<GenParams>) => onParams({ ...params, ...patch });

  return (
    <Dialog title="Chat settings" onClose={close}>
      <div className="col" style={{ gap: 18 }}>
        <div className="group">
          <Row
            icon={model ? <ProviderBadge name={model.kindName} size={28} /> : undefined}
            title={model?.model.displayName ?? 'No model selected'}
            subtitle={model?.providerLabel}
            onClick={() => {
              close();
              onChangeModel();
            }}
          />
        </div>

        {caps && caps.reasoning.kind !== 'NONE' && (
          <section className="col gap-8">
            <span className="field-label" style={{ marginLeft: 4 }}>Reasoning</span>
            <Segmented
              options={[null, ...caps.reasoning.efforts] as (Effort | null)[]}
              selected={params.effort ?? null}
              label={(e) => (e ? EFFORT_INFO[e].label : 'Auto')}
              onSelect={(e) => set({ effort: e })}
            />
            <span className="field-hint" style={{ marginLeft: 4 }}>{effortHint(params.effort)}</span>
            <div className="group">
              <SwitchRow icon={<Brain size={20} />} title="Show reasoning" subtitle="Stream the model's reasoning summary while it thinks." checked={params.showThinking} onChange={(v) => set({ showThinking: v })} />
              {caps.proMode && (
                <>
                  <Divider />
                  <SwitchRow icon={<GemIcon size={20} />} title="Pro mode" subtitle="Does more work per answer. Slower and costs more." checked={params.proMode} onChange={(v) => set({ proMode: v })} />
                </>
              )}
            </div>
          </section>
        )}

        {caps?.verbosity && (
          <section className="col gap-8">
            <span className="field-label" style={{ marginLeft: 4 }}>Length</span>
            <Segmented
              options={[null, 'LOW', 'MEDIUM', 'HIGH'] as (Verbosity | null)[]}
              selected={params.verbosity ?? null}
              label={(v) => (v ? VERBOSITY_INFO[v].label : 'Auto')}
              onSelect={(v) => set({ verbosity: v })}
            />
          </section>
        )}

        <Group title="Tools and speed">
          <SwitchRow
            icon={<Globe size={20} />}
            title="Web search"
            subtitle={
              !caps ? 'Choose a model first.'
                : caps.webSearch ? 'Let the model search the web and cite sources.'
                  : canSearch ? 'Uses your search key, then reads pages as needed.'
                    : caps.tools ? 'Add a search key in Settings → Tools to let this model search.'
                      : 'This model can’t use tools or search the web.'
            }
            checked={params.webSearch && canSearch}
            onChange={(v) => set({ webSearch: v })}
            disabled={!canSearch}
          />
          {caps?.tools && (servers.length > 0 || skillCount > 0) && (
            <>
              <Divider />
              <SwitchRow
                icon={<Wand2 size={20} />}
                title="MCP tools and skills"
                subtitle={[servers.length ? `${servers.length} server${servers.length === 1 ? '' : 's'}` : '', skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') + ' available in this chat.'}
                checked={params.tools}
                onChange={(v) => set({ tools: v })}
              />
              {params.tools &&
                servers.map((s) => (
                  <div key={s.id}>
                    <Divider />
                    <SwitchRow
                      icon={<Server size={20} />}
                      title={s.name}
                      subtitle={s.status ?? `${parseJson<unknown[]>(s.toolsJson, []).length} tools`}
                      checked={!params.disabledMcpServers.includes(s.id)}
                      onChange={(v) => set({ disabledMcpServers: v ? params.disabledMcpServers.filter((x) => x !== s.id) : [...params.disabledMcpServers, s.id] })}
                    />
                  </div>
                ))}
            </>
          )}
          {computer && caps?.tools && (
            <>
              <Divider />
              <SwitchRow
                icon={<Monitor size={20} />}
                title="Use this computer"
                subtitle={local.computerTools ? 'The model can run commands and read and edit files in the working folder.' : 'Off for every chat. Turn it on to let models run commands and edit files.'}
                checked={local.computerTools && params.tools}
                onChange={(v) => {
                  if (v && !local.computerTools) app.settings.updateLocal((l) => ({ ...l, computerTools: true }));
                  set({ tools: v || !local.computerTools ? true : params.tools });
                  if (!v) app.settings.updateLocal((l) => ({ ...l, computerTools: false }));
                }}
              />
              {local.computerTools && onWorkspace && (
                <>
                  <Divider />
                  <Row
                    icon={<FolderOpen size={20} />}
                    title="Working folder"
                    subtitle={<span className="mono" style={{ fontSize: 12.5 }}>{workspace || 'Not set'}</span>}
                    onClick={async () => {
                      const picked = await computer.pickFolder(workspace ?? undefined);
                      if (picked) onWorkspace(picked);
                    }}
                  />
                </>
              )}
            </>
          )}
          {caps?.tools && (
            <>
              <Divider />
              <SwitchRow icon={<Rocket size={20} />} title="YOLO mode" subtitle="Run tools without asking, in every chat." checked={synced.yoloMode} onChange={(v) => app.settings.updateSynced((s) => ({ ...s, yoloMode: v }))} />
            </>
          )}
          {caps?.fastMode && (
            <>
              <Divider />
              <SwitchRow icon={<Zap size={20} />} title="Fast mode" subtitle="Up to 2.5× faster output at premium pricing." checked={params.fastMode} onChange={(v) => set({ fastMode: v })} />
            </>
          )}
        </Group>

        {caps?.sampling && (
          <section className="col gap-8">
            <span className="field-label row" style={{ marginLeft: 4 }}>
              <span className="grow">Temperature</span>
              <button type="button" className="c-2 t-label-m" onClick={() => set({ temperature: null })} title="Use the model's default">
                {params.temperature != null ? params.temperature.toFixed(2) : 'Auto'}
              </button>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={params.temperature ?? 1}
              onChange={(e) => set({ temperature: Number(e.target.value) })}
              className="range"
              aria-label="Temperature"
            />
          </section>
        )}

        <section className="col gap-8">
          <span className="field-label" style={{ marginLeft: 4 }}>Maximum reply length</span>
          <Segmented
            options={[null, 2_000, 8_000, 16_000, 32_000, 64_000] as (number | null)[]}
            selected={params.maxOutputTokens ?? null}
            label={(n) => (n ? Format.tokens(n) : 'Auto')}
            onSelect={(n) => set({ maxOutputTokens: n })}
          />
        </section>

        {onSystemPrompt && (
          <Field label="Instructions for this chat" hint="Added to the assistant's instructions for this chat only.">
            <textarea className="textarea" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Answer in Spanish. Keep replies under 150 words." />
          </Field>
        )}

        <Button
          variant="tonal"
          block
          onClick={async () => {
            await app.settings.updateSynced((s) => ({ ...s, defaultParams: params, defaultModel: model?.ref ?? s.defaultModel }));
            toast('New chats will use these settings.');
          }}
        >
          Use these settings for new chats
        </Button>
      </div>
    </Dialog>
  );
}
