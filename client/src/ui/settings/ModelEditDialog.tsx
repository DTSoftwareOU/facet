/** Edit one model of a provider: name, visibility, what it makes, capabilities, limits and price (port of ModelEditSheet.kt). */
import { Brain, Eye, EyeOff, FileText, Gauge, Gem, Globe, Image as ImageIcon, Trash2, Type, Wand2, Zap } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import type { ProviderEntity } from '../../data/entities';
import type { ModelPrefs } from '../../data/providers';
import { canRun, modelInfo } from '../../llm/catalog';
import type { ProviderKind } from '../../llm/providers';
import {
  EFFORT_INFO,
  EFFORTS,
  MODEL_OUTPUT_INFO,
  type Effort,
  type ModelCaps,
  type ModelOutput,
  type ModelPricing,
  type ReasoningKind,
} from '../../llm/types';
import { Segmented } from '../chat/ChatSettings';
import { Button, Confirm, Dialog, Divider, Field, Row, SwitchRow } from '../components/primitives';
import { ChipChoice, OutlinedGroup, SectionLabel, useStableCallback } from './common';

const ALL_OUTPUTS = Object.keys(MODEL_OUTPUT_INFO) as ModelOutput[];
const REASONING_KINDS: ReasoningKind[] = ['NONE', 'EFFORT', 'BUDGET'];
const REASONING_LABEL: Record<ReasoningKind, string> = { NONE: 'None', EFFORT: 'Effort levels', BUDGET: 'Thinking budget' };

/** "128000", "128k", "1.5m" → tokens; null when not a positive number. */
function parseTokens(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[,_\s]/g, '');
  if (!t) return null;
  const last = t[t.length - 1];
  const mult = last === 'k' ? 1_000 : last === 'm' ? 1_000_000 : 1;
  const num = mult === 1 ? t : t.slice(0, -1);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(num)) return null;
  const v = Number(num) * mult;
  return v >= 1 && v <= 2_147_483_647 ? Math.floor(v) : null;
}

/** "2.5", "2,5", "$2.50" → 2.5; null when not a non-negative number. */
function parsePrice(s: string): number | null {
  const t = s.trim().replace(/^\$/, '').replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function sameEfforts(a: readonly Effort[], b: readonly Effort[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}

function sameCaps(a: ModelCaps | null | undefined, b: ModelCaps | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.vision === b.vision && a.pdf === b.pdf && a.webSearch === b.webSearch && a.sampling === b.sampling &&
    a.verbosity === b.verbosity && a.proMode === b.proMode && a.fastMode === b.fastMode &&
    a.refusalFallback === b.refusalFallback && a.tools === b.tools &&
    a.reasoning.kind === b.reasoning.kind && sameEfforts(a.reasoning.efforts, b.reasoning.efforts) &&
    (a.reasoning.defaultEffort ?? null) === (b.reasoning.defaultEffort ?? null) && a.reasoning.summaries === b.reasoning.summaries
  );
}

function samePricing(a: ModelPricing | null | undefined, b: ModelPricing | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.input === b.input && a.output === b.output && (a.cacheRead ?? null) === (b.cacheRead ?? null) && (a.cacheWrite ?? null) === (b.cacheWrite ?? null);
}

function samePrefs(a: ModelPrefs, b: ModelPrefs): boolean {
  return (
    (a.name ?? null) === (b.name ?? null) && !!a.hidden === !!b.hidden && (a.output ?? null) === (b.output ?? null) &&
    sameCaps(a.caps, b.caps) && (a.contextWindow ?? null) === (b.contextWindow ?? null) &&
    (a.maxOutput ?? null) === (b.maxOutput ?? null) && samePricing(a.pricing, b.pricing)
  );
}

const asText = (n: number | null | undefined) => (n == null ? '' : String(n));

export function ModelEditDialog({ provider: p, kind, modelId, onClose }: {
  provider: ProviderEntity;
  kind: ProviderKind;
  modelId: string;
  onClose: () => void;
}) {
  const app = getApp();
  const close = useStableCallback(onClose);
  // Read once when the dialog opens, so a model-list refresh doesn't reset what you're typing.
  const [snap] = useState(() => ({
    base: app.providers.baseModels(p).find((m) => m.id === modelId) ?? modelInfo(modelId, modelId),
    current: app.providers.modelInfo(p, modelId),
    saved: app.providers.modelPrefs(p)[modelId] ?? ({} as ModelPrefs),
    isCustom: app.providers.customModels(p).some((m) => m.id === modelId),
  }));
  const { base, current, saved, isCustom } = snap;

  const [name, setName] = useState(saved.name ?? '');
  const [hidden, setHidden] = useState(!!saved.hidden);
  const [caps, setCaps] = useState<ModelCaps>(current.caps);
  const [output, setOutput] = useState<ModelOutput>(current.output);
  const [context, setContext] = useState(asText(saved.contextWindow));
  const [maxOut, setMaxOut] = useState(asText(saved.maxOutput));
  const [priceIn, setPriceIn] = useState(asText(saved.pricing?.input));
  const [priceOut, setPriceOut] = useState(asText(saved.pricing?.output));
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const closeConfirm = useCallback(() => setConfirmRemove(false), []);

  const ctxVal = parseTokens(context);
  const maxVal = parseTokens(maxOut);
  const inVal = parsePrice(priceIn);
  const outVal = parsePrice(priceOut);
  const ctxBad = context.trim() !== '' && ctxVal == null;
  const maxBad = maxOut.trim() !== '' && maxVal == null;
  const inBad = priceIn.trim() !== '' && inVal == null;
  const outBad = priceOut.trim() !== '' && outVal == null;
  const isText = output === 'TEXT';
  const invalid = isText && (ctxBad || maxBad || inBad || outBad);

  const draft = (): ModelPrefs => {
    // A hidden field with an unreadable number keeps its saved value instead of dropping the edit.
    let pricing: ModelPricing | null;
    if (inBad || outBad) pricing = saved.pricing ?? null;
    else if (inVal == null && outVal == null) pricing = null;
    else {
      const next: ModelPricing = {
        input: inVal ?? base.pricing?.input ?? 0,
        output: outVal ?? base.pricing?.output ?? 0,
        cacheRead: base.pricing?.cacheRead ?? null,
        cacheWrite: base.pricing?.cacheWrite ?? null,
      };
      pricing = samePricing(next, base.pricing) ? null : next;
    }
    const trimmed = name.trim();
    return {
      name: trimmed && trimmed !== base.displayName ? trimmed : null,
      hidden,
      output: output !== base.output ? output : null,
      caps: sameCaps(caps, base.caps) ? null : caps,
      contextWindow: ctxBad ? saved.contextWindow ?? null : ctxVal != null && ctxVal !== base.contextWindow ? ctxVal : null,
      maxOutput: maxBad ? saved.maxOutput ?? null : maxVal != null && maxVal !== base.maxOutput ? maxVal : null,
      pricing,
    };
  };

  const save = async () => {
    const next = draft();
    if (!samePrefs(next, saved)) {
      setBusy(true);
      try {
        await app.providers.setModelPrefs(p.id, modelId, next);
      } finally {
        setBusy(false);
      }
    }
    close();
  };

  const restore = () => {
    setName('');
    setHidden(false);
    setCaps(base.caps);
    setOutput(base.output);
    setContext('');
    setMaxOut('');
    setPriceIn('');
    setPriceOut('');
  };

  if (confirmRemove) {
    return (
      <Confirm
        title={`Remove ${current.displayName}?`}
        body="It disappears from the model list on all your devices. Chats that used it stay."
        confirm="Remove"
        danger
        onConfirm={async () => {
          await app.providers.removeCustomModel(p.id, modelId);
          close();
        }}
        onClose={closeConfirm}
      />
    );
  }

  const r = caps.reasoning;
  const setReasoningKind = (k: ReasoningKind) =>
    setCaps({
      ...caps,
      reasoning: k === 'NONE'
        ? { ...r, kind: k, efforts: [], defaultEffort: null }
        : { ...r, kind: k, efforts: r.efforts.length > 0 ? r.efforts : ['LOW', 'MEDIUM', 'HIGH'] },
    });
  const toggleEffort = (e: Effort) => {
    const next = r.efforts.includes(e) ? r.efforts.filter((x) => x !== e) : [...r.efforts, e].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    setCaps({ ...caps, reasoning: { ...r, efforts: next, defaultEffort: r.defaultEffort && next.includes(r.defaultEffort) ? r.defaultEffort : null } });
  };
  const capRow = (icon: ReactNode, title: string, subtitle: string, key: 'vision' | 'pdf' | 'tools' | 'webSearch' | 'sampling' | 'verbosity' | 'proMode' | 'fastMode') => (
    <SwitchRow icon={icon} title={title} subtitle={subtitle} checked={caps[key]} onChange={(v) => setCaps({ ...caps, [key]: v })} />
  );

  return (
    <Dialog
      title={<span className="ellipsis" style={{ display: 'block' }}>{name.trim() || base.displayName}</span>}
      onClose={close}
      closeOnScrim={false}
      footer={
        <>
          <Button variant="text" style={{ marginRight: 'auto' }} onClick={restore}>Restore defaults</Button>
          <Button variant="text" onClick={close}>Cancel</Button>
          <Button onClick={save} busy={busy} disabled={invalid}>Save</Button>
        </>
      }
    >
      <div className="col gap-16">
        <span className="t-label-m c-3 ellipsis" style={{ fontWeight: 400, marginTop: -6 }}>
          <span className="mono" style={{ fontSize: 12.5 }}>{modelId}</span> · {p.label}
        </span>

        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={base.displayName} />
        </Field>

        <div className="group outlined">
          <SwitchRow
            icon={hidden ? <EyeOff size={20} /> : <Eye size={20} />}
            title="Show in model picker"
            subtitle={hidden ? 'Hidden. Chats that already use it keep working.' : 'Listed when you choose a model.'}
            checked={!hidden}
            onChange={(v) => setHidden(!v)}
          />
        </div>

        <section className="col gap-8">
          <SectionLabel>Makes</SectionLabel>
          <ChipChoice
            ariaLabel="What this model makes"
            options={ALL_OUTPUTS.filter((o) => o === output || canRun(kind, o))}
            selected={output}
            label={(o) => MODEL_OUTPUT_INFO[o].label}
            onSelect={setOutput}
          />
          {output !== base.output && (
            <span className="field-hint section-label">
              Sorted as {MODEL_OUTPUT_INFO[base.output].label.toLowerCase()} automatically. Your choice moves it to the {MODEL_OUTPUT_INFO[output].label.toLowerCase()} list.
            </span>
          )}
        </section>

        {isText && (
          <>
            <OutlinedGroup title="Capabilities">
              {capRow(<ImageIcon size={20} />, 'Images', 'Accepts photos and screenshots.', 'vision')}
              <Divider />
              {capRow(<FileText size={20} />, 'PDFs', 'Reads PDF files directly.', 'pdf')}
              <Divider />
              {capRow(<Wand2 size={20} />, 'Tools', 'Facet search, MCP servers and skills.', 'tools')}
              <Divider />
              {capRow(<Globe size={20} />, 'Built-in web search', 'The provider searches the web itself.', 'webSearch')}
              <Divider />
              {capRow(<Gauge size={20} />, 'Temperature', 'Accepts temperature and top-p.', 'sampling')}
              {kind.style === 'OPENAI_RESPONSES' && (
                <>
                  <Divider />
                  {capRow(<Type size={20} />, 'Verbosity', 'Concise, balanced or detailed answers.', 'verbosity')}
                  <Divider />
                  {capRow(<Gem size={20} />, 'Pro mode', 'More work per answer.', 'proMode')}
                </>
              )}
              {kind.style === 'ANTHROPIC' && (
                <>
                  <Divider />
                  {capRow(<Zap size={20} />, 'Fast mode', 'Faster output at premium pricing.', 'fastMode')}
                </>
              )}
            </OutlinedGroup>

            <section className="col gap-8">
              <SectionLabel>Reasoning</SectionLabel>
              <Segmented options={REASONING_KINDS} selected={r.kind} label={(k) => REASONING_LABEL[k]} onSelect={setReasoningKind} />
              {r.kind !== 'NONE' && (
                <>
                  <span className="field-hint section-label" style={{ marginTop: 4 }}>Levels it accepts</span>
                  <div className="pill-list" role="group" aria-label="Levels it accepts">
                    {EFFORTS.map((e) => (
                      <button key={e} type="button" role="checkbox" aria-checked={r.efforts.includes(e)} className={'chip' + (r.efforts.includes(e) ? ' on' : '')} onClick={() => toggleEffort(e)}>
                        {EFFORT_INFO[e].label}
                      </button>
                    ))}
                  </div>
                  {r.efforts.length > 0 && (
                    <>
                      <span className="field-hint section-label" style={{ marginTop: 4 }}>Default level</span>
                      <div className="pill-list" role="radiogroup" aria-label="Default level">
                        {r.efforts.map((e) => (
                          <button
                            key={e}
                            type="button"
                            role="radio"
                            aria-checked={r.defaultEffort === e}
                            className={'chip' + (r.defaultEffort === e ? ' on' : '')}
                            onClick={() => setCaps({ ...caps, reasoning: { ...r, defaultEffort: r.defaultEffort === e ? null : e } })}
                          >
                            {EFFORT_INFO[e].label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="group outlined" style={{ marginTop: 4 }}>
                    <SwitchRow
                      icon={<Brain size={20} />}
                      title="Shows its thinking"
                      subtitle="Streams readable reasoning you can expand."
                      checked={r.summaries}
                      onChange={(v) => setCaps({ ...caps, reasoning: { ...r, summaries: v } })}
                    />
                  </div>
                </>
              )}
            </section>

            <OutlinedGroup title="Limits">
              <div className="fields-2 group-pad">
                <Field label="Context window (tokens)" error={ctxBad ? 'Type a number, like 200000 or 200k.' : undefined}>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    placeholder={base.contextWindow ? Format.contextWindow(base.contextWindow) : 'Unknown'}
                  />
                </Field>
                <Field label="Max output (tokens)" error={maxBad ? 'Type a number, like 64000 or 64k.' : undefined}>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={maxOut}
                    onChange={(e) => setMaxOut(e.target.value)}
                    placeholder={base.maxOutput ? Format.tokens(base.maxOutput) : 'Provider default'}
                  />
                </Field>
              </div>
              <p className="field-hint" style={{ margin: '-6px 16px 14px' }}>Empty uses the provider’s value. You can type 128k or 1m.</p>
            </OutlinedGroup>

            <OutlinedGroup title="Price, USD per 1M tokens">
              <div className="fields-2 group-pad">
                <Field label="Input" error={inBad ? 'Type a price, like 2.5.' : undefined}>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={priceIn}
                    onChange={(e) => setPriceIn(e.target.value)}
                    placeholder={base.pricing ? String(base.pricing.input) : 'Unknown'}
                  />
                </Field>
                <Field label="Output" error={outBad ? 'Type a price, like 10.' : undefined}>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={priceOut}
                    onChange={(e) => setPriceOut(e.target.value)}
                    placeholder={base.pricing ? String(base.pricing.output) : 'Unknown'}
                  />
                </Field>
              </div>
            </OutlinedGroup>
          </>
        )}

        {isCustom && (
          <div className="group outlined">
            <Row icon={<Trash2 size={20} />} title="Remove model" subtitle="You added this model ID by hand." danger onClick={() => setConfirmRemove(true)} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
