import { useLiveQuery } from 'dexie-react-hooks';
import { Brain, FolderOpen, Gem as GemIcon, Globe, Monitor, Rocket, Server, Wand2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import { parseJson } from '../../core/json';
import { db } from '../../data/db';
import { formatList, formatNumber, t, tm, tn } from '../../i18n';
import { EFFORT_INFO, VERBOSITY_INFO, type Effort, type GenParams, type Verbosity } from '../../llm/types';
import { platform } from '../../platform';
import { isSearchKind } from '../../tools/types';
import { ProviderBadge } from '../components/Avatars';
import { Button, Dialog, Divider, Field, Group, Row, SwitchRow, useToast } from '../components/primitives';
import { useLocalPrefs, useSyncedPrefs } from '../hooks';
import type { ResolvedModel } from './ModelPicker';

export function Segmented<T>({ options, selected, label, onSelect }: { options: T[]; selected: T; label: (option: T) => string; onSelect: (option: T) => void }) {
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
      return t('The model decides how long to think.');
    case 'NONE':
      return t('Answers immediately without extended reasoning.');
    case 'MINIMAL':
    case 'LOW':
      return t('Quick answers for simple questions. Cheapest.');
    case 'MEDIUM':
      return t('Balanced depth, speed and cost.');
    case 'HIGH':
      return t('Thinks longer for harder problems.');
    default:
      return t('Maximum depth for the hardest problems. Slowest and most expensive.');
  }
}

/** Per-chat model parameters, tools and instructions (the chat settings sheet on Android). */
export function ChatSettings({ model, params, onParams, systemPrompt, onSystemPrompt, computerLabel, onComputer, onChangeModel, onClose }: {
  model: ResolvedModel | null;
  params: GenParams;
  onParams: (p: GenParams) => void;
  systemPrompt: string | null;
  onSystemPrompt: ((s: string | null) => void) | null;
  /** Where the chat's computer tools work, e.g. "Documents" or "OFFICE-PC · app"; null for none. */
  computerLabel: string | null;
  /** Opens the folder or PC chooser; null when no computer is reachable. */
  onComputer: (() => void) | null;
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
    <Dialog title={t('Chat settings')} onClose={close}>
      <div className="col" style={{ gap: 18 }}>
        <div className="group">
          <Row
            icon={model ? <ProviderBadge name={model.kindName} size={28} /> : undefined}
            title={model?.model.displayName ?? t('No model selected')}
            subtitle={model?.providerLabel}
            onClick={() => {
              close();
              onChangeModel();
            }}
          />
        </div>

        {caps && caps.reasoning.kind !== 'NONE' && (
          <section className="col gap-8">
            <span className="field-label" style={{ marginInlineStart: 4 }}>{t('Reasoning')}</span>
            <Segmented
              options={[null, ...caps.reasoning.efforts] as (Effort | null)[]}
              selected={params.effort ?? null}
              label={(e) => (e ? tm(EFFORT_INFO[e].label) : t('Auto'))}
              onSelect={(e) => set({ effort: e })}
            />
            <span className="field-hint" style={{ marginInlineStart: 4 }}>{effortHint(params.effort)}</span>
            <div className="group">
              <SwitchRow icon={<Brain size={20} />} title={t('Show reasoning')} subtitle={t("Stream the model's reasoning summary while it thinks.")} checked={params.showThinking} onChange={(v) => set({ showThinking: v })} />
              {caps.proMode && (
                <>
                  <Divider />
                  <SwitchRow icon={<GemIcon size={20} />} title={t('Pro mode')} subtitle={t('Does more work per answer. Slower and costs more.')} checked={params.proMode} onChange={(v) => set({ proMode: v })} />
                </>
              )}
            </div>
          </section>
        )}

        {caps?.verbosity && (
          <section className="col gap-8">
            <span className="field-label" style={{ marginInlineStart: 4 }}>{t('Length')}</span>
            <Segmented
              options={[null, 'LOW', 'MEDIUM', 'HIGH'] as (Verbosity | null)[]}
              selected={params.verbosity ?? null}
              label={(v) => (v ? tm(VERBOSITY_INFO[v].label) : t('Auto'))}
              onSelect={(v) => set({ verbosity: v })}
            />
          </section>
        )}

        <Group title={t('Tools and speed')}>
          <SwitchRow
            icon={<Globe size={20} />}
            title={t('Web search')}
            subtitle={
              !caps ? t('Choose a model first.')
                : caps.webSearch ? t('Let the model search the web and cite sources.')
                  : canSearch ? t('Uses your search key, then reads pages as needed.')
                    : caps.tools ? t('Add a search key in Settings → Tools to let this model search.')
                      : t('This model can’t use tools or search the web.')
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
                title={t('MCP tools and skills')}
                subtitle={t('{things} available in this chat.', {
                  things: formatList([
                    servers.length ? tn('{count} server', '{count} servers', servers.length) : '',
                    skillCount ? tn('{count} skill', '{count} skills', skillCount) : '',
                  ].filter(Boolean)),
                })}
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
                      subtitle={s.status ?? tn('{count} tool', '{count} tools', parseJson<unknown[]>(s.toolsJson, []).length)}
                      checked={!params.disabledMcpServers.includes(s.id)}
                      onChange={(v) => set({ disabledMcpServers: v ? params.disabledMcpServers.filter((x) => x !== s.id) : [...params.disabledMcpServers, s.id] })}
                    />
                  </div>
                ))}
            </>
          )}
          {(computer || onComputer) && caps?.tools && (
            <>
              <Divider />
              <SwitchRow
                icon={<Monitor size={20} />}
                title={computer ? t('Use this computer') : t('Use your PC')}
                subtitle={local.computerTools ? t('The model can run commands and read and edit files in the working folder.') : t('Off for every chat. Turn it on to let models run commands and edit files.')}
                checked={local.computerTools && params.tools}
                onChange={(v) => {
                  if (v && !local.computerTools) app.settings.updateLocal((l) => ({ ...l, computerTools: true }));
                  set({ tools: v || !local.computerTools ? true : params.tools });
                  if (!v) app.settings.updateLocal((l) => ({ ...l, computerTools: false }));
                }}
              />
              {local.computerTools && onComputer && (
                <>
                  <Divider />
                  <Row
                    icon={<FolderOpen size={20} />}
                    title={t('Working folder')}
                    subtitle={<span className="mono" style={{ fontSize: 12.5 }}>{computerLabel ? <bdi dir="ltr">{computerLabel}</bdi> : t('Not set')}</span>}
                    onClick={onComputer}
                  />
                </>
              )}
            </>
          )}
          {caps?.tools && (
            <>
              <Divider />
              <SwitchRow icon={<Rocket size={20} />} title={t('YOLO mode')} subtitle={t('Run tools without asking, in every chat.')} checked={synced.yoloMode} onChange={(v) => app.settings.updateSynced((s) => ({ ...s, yoloMode: v }))} />
            </>
          )}
          {caps?.fastMode && (
            <>
              <Divider />
              <SwitchRow icon={<Zap size={20} />} title={t('Fast mode')} subtitle={t('Up to 2.5× faster output at premium pricing.')} checked={params.fastMode} onChange={(v) => set({ fastMode: v })} />
            </>
          )}
        </Group>

        {caps?.sampling && (
          <section className="col gap-8">
            <span className="field-label row" style={{ marginInlineStart: 4 }}>
              <span className="grow">{t('Temperature')}</span>
              <button type="button" className="c-2 t-label-m" onClick={() => set({ temperature: null })} title={t("Use the model's default")}>
                {params.temperature != null ? formatNumber(params.temperature, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t('Auto')}
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
              aria-label={t('Temperature')}
            />
          </section>
        )}

        <section className="col gap-8">
          <span className="field-label" style={{ marginInlineStart: 4 }}>{t('Maximum reply length')}</span>
          <Segmented
            options={[null, 2_000, 8_000, 16_000, 32_000, 64_000] as (number | null)[]}
            selected={params.maxOutputTokens ?? null}
            label={(n) => (n ? Format.tokens(n) : t('Auto'))}
            onSelect={(n) => set({ maxOutputTokens: n })}
          />
        </section>

        {onSystemPrompt && (
          <Field label={t('Instructions for this chat')} hint={t("Added to the assistant's instructions for this chat only.")}>
            <textarea className="textarea" rows={3} dir="auto" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('e.g. Answer in Spanish. Keep replies under 150 words.')} />
          </Field>
        )}

        <Button
          variant="tonal"
          block
          onClick={async () => {
            await app.settings.updateSynced((s) => ({ ...s, defaultParams: params, defaultModel: model?.ref ?? s.defaultModel }));
            toast(t('New chats will use these settings.'));
          }}
        >
          {t('Use these settings for new chats')}
        </Button>
      </div>
    </Dialog>
  );
}
