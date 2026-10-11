/** Skills on the Tools page: the list, imports (file, link, pasted SKILL.md), examples and the editor. */
import { useLiveQuery } from 'dexie-react-hooks';
import { ClipboardPaste, Download, FileText, Infinity as InfinityIcon, Link, Plus, Power, Trash2, WandSparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { getApp } from '../../app';
import type { SkillEntity } from '../../data/entities';
import { sentences, t, tn } from '../../i18n';
import { platform } from '../../platform';
import { SkillParser, SkillRepository } from '../../tools/skills';
import type { SkillResource } from '../../tools/types';
import { Button, Confirm, Dialog, Divider, Field, Group, Menu, Row, Spinner, Switch, SwitchRow, useMenu, useToast } from '../components/primitives';
import { ui } from '../nav';
import { ToolsRow, ToolsStatus, ToolsSubhead, ToolsToggleChip, errorText, useStableCallback } from './ToolsShared';

const openSkill = (id: string) => ui.openSettings('tools', 'skill:' + id);

/** "Imported meeting-notes." with an Open action. */
function useImported() {
  const toast = useToast();
  return (s: SkillEntity, how: 'imported' | 'added' = 'imported') =>
    toast(how === 'added' ? t('Added {name}.', { name: s.name }) : t('Imported {name}.', { name: s.name }), { label: t('Open'), run: () => openSkill(s.id) });
}

/**
 * What an example skill does, in the interface language. The skill itself (name, description,
 * instructions) is for models and is added in English.
 */
function exampleSummary(ex: (typeof SkillRepository.EXAMPLES)[number]): string {
  switch (ex.name) {
    case 'meeting-notes':
      return t('Turn rough notes or a transcript into clear meeting notes with decisions and action items.');
    case 'code-review':
      return t('Review code changes for bugs, security issues and maintainability, with concrete fixes.');
    case 'trip-planner':
      return t('Plan trips day by day with realistic travel times, budgets and booking tips.');
    default:
      return ex.description.split('. Use when')[0].replace(/\.?$/, '.');
  }
}

/** The skills group on the Tools overview. */
export function SkillsOverviewGroup() {
  const app = getApp();
  const skills = useLiveQuery(() => app.skills.all(), []);
  const imported = useImported();
  const menu = useMenu();
  const file = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'url' | 'paste' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const closeDialog = useStableCallback(() => setDialog(null));

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setProblem(null);
    try {
      imported(await app.skills.importFile(f.name, new Uint8Array(await f.arrayBuffer())));
    } catch (err) {
      setProblem(errorText(err, t('Couldn’t import that file. Choose a SKILL.md, or a .zip that contains one.')));
    }
  };

  const addExample = async (ex: (typeof SkillRepository.EXAMPLES)[number]) => {
    setAdding(ex.name);
    try {
      imported(await app.skills.save({ name: ex.name, description: ex.description, instructions: ex.body }), 'added');
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="col gap-12">
      <Group
        title={t('Skills')}
        footer={t('Skills are reusable instructions a model loads when a task calls for them, like a checklist for code review or a format for meeting notes. They work with any model that supports tools and sync to all your devices. Compatible with SKILL.md files.')}
      >
        {skills?.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <Divider />}
            <ToolsRow
              icon={<WandSparkles size={20} />}
              title={<bdi>{s.name}</bdi>}
              subtitle={<span className="tools-clamp"><bdi>{s.description}</bdi></span>}
              onClick={() => openSkill(s.id)}
              trailing={
                <>
                  <ToolsToggleChip
                    on={s.alwaysOn}
                    icon={<InfinityIcon size={14} />}
                    title={s.alwaysOn ? t('Always on: the full instructions are in every chat') : t('Load only when a task calls for it. Click to include it in every chat.')}
                    onChange={(v) => void app.skills.setAlwaysOn(s.id, v)}
                  >
                    {t('Always on')}
                  </ToolsToggleChip>
                  <Switch checked={s.enabled} label={t('Use {name}', { name: s.name })} onChange={(v) => void app.skills.setEnabled(s.id, v)} />
                </>
              }
            />
          </div>
        ))}
        {skills && skills.length === 0 && (
          <Row icon={<WandSparkles size={20} />} title={t('No skills yet')} subtitle={t('Create one, import a SKILL.md or .zip, or start with an example below.')} />
        )}
        {skills && <Divider full={skills.length === 0} />}
        <ToolsRow icon={<Plus size={20} />} title={t('New skill')} tone="primary" onClick={() => ui.openSettings('tools', 'skill:new')} />
        <Divider />
        <ToolsRow icon={<Download size={20} />} title={t('Import a skill')} tone="primary" onClick={menu.open} />
      </Group>

      {problem && <ToolsStatus tone="error">{problem}</ToolsStatus>}

      {skills && skills.length === 0 && (
        <Group title={t('Start with an example')}>
          {SkillRepository.EXAMPLES.map((ex, i) => (
            <div key={ex.name}>
              {i > 0 && <Divider />}
              <Row
                icon={adding === ex.name ? <Spinner size={18} /> : <Plus size={20} />}
                title={ex.name}
                subtitle={exampleSummary(ex)}
                onClick={() => void addExample(ex)}
                disabled={adding != null}
              />
            </div>
          ))}
        </Group>
      )}

      <input ref={file} type="file" accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip" hidden onChange={onFile} />
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          items={[
            { label: t('From a file (.md or .zip)'), icon: <FileText size={17} />, onSelect: () => file.current?.click() },
            { label: t('From a link'), icon: <Link size={17} />, onSelect: () => setDialog('url') },
            { label: t('Paste SKILL.md text'), icon: <ClipboardPaste size={17} />, onSelect: () => setDialog('paste') },
          ]}
        />
      )}
      {dialog === 'url' && <SkillUrlDialog onClose={closeDialog} />}
      {dialog === 'paste' && <SkillPasteDialog onClose={closeDialog} />}
    </section>
  );
}

function SkillUrlDialog({ onClose }: { onClose: () => void }) {
  const app = getApp();
  const imported = useImported();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^https?:\/\/\S+$/i.test(url.trim());
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      imported(await app.skills.importUrl(url.trim()));
      onClose();
    } catch (e) {
      setError(errorText(e, t('Couldn’t import from that link.')));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('Import from a link')}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={onClose}>{t('Cancel')}</Button>
          <Button busy={busy} disabled={!valid} onClick={submit}>{t('Import')}</Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label={t('Link')} hint={t('A SKILL.md, a Markdown file or a .zip. GitHub file links work too.')} error={error ?? undefined}>
          <input
            className="input mono"
            dir="ltr"
            value={url}
            inputMode="url"
            spellCheck={false}
            placeholder="https://…/SKILL.md"
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </Field>
        {platform().corsLimited && (
          <span className="field-hint">{t('Some sites don’t allow downloads from web pages. If a link doesn’t work, download the file and import it instead.')}</span>
        )}
      </div>
    </Dialog>
  );
}

const PASTE_PLACEHOLDER = `---
name: meeting-notes
description: Turn rough notes into clear meeting notes. Use when the user shares notes or a transcript.
---

# Meeting notes

Step-by-step instructions…`;

function SkillPasteDialog({ onClose }: { onClose: () => void }) {
  const app = getApp();
  const imported = useImported();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      imported(await app.skills.importMarkdown(text));
      onClose();
    } catch (e) {
      setError(errorText(e, t('Couldn’t read that as a skill.')));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('Paste a skill')}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button variant="text" onClick={onClose}>{t('Cancel')}</Button>
          <Button busy={busy} disabled={!text.trim()} onClick={submit}>{t('Import')}</Button>
        </>
      }
    >
      <Field
        label="SKILL.md"
        hint={t('Frontmatter with name and description, then the instructions in Markdown. Without frontmatter, the first heading becomes the name.')}
        error={error ?? undefined}
      >
        <textarea
          className="textarea tools-code-input"
          dir="auto"
          rows={14}
          value={text}
          spellCheck={false}
          placeholder={PASTE_PLACEHOLDER}
          onChange={(e) => { setText(e.target.value); setError(null); }}
        />
      </Field>
    </Dialog>
  );
}

/** Settings → Tools → a skill ([id] null: a new one). */
export function SkillEditPage({ id }: { id: string | null }) {
  const app = getApp();
  const toast = useToast();
  const [loaded, setLoaded] = useState(id == null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [resources, setResources] = useState<SkillResource[]>([]);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [initial, setInitial] = useState('');
  const [viewing, setViewing] = useState<SkillResource | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeConfirm = useStableCallback(() => setConfirm(null));
  const closeViewer = useStableCallback(() => setViewing(null));

  useEffect(() => {
    if (!id) return;
    let live = true;
    void app.skills.get(id).then((s) => {
      if (!live) return;
      if (!s || s.deleted) {
        setMissing(true);
        return;
      }
      setName(s.name);
      setDescription(s.description);
      setInstructions(s.instructions);
      setEnabled(s.enabled);
      setAlwaysOn(s.alwaysOn);
      setResources(app.skills.resources(s));
      setSourceUrl(s.sourceUrl ?? null);
      setInitial(JSON.stringify([s.name, s.description, s.instructions, s.enabled, s.alwaysOn]));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const back = () => ui.openSettings('tools');
  const dirty = loaded && JSON.stringify([name, description, instructions, enabled, alwaysOn]) !== (id ? initial : JSON.stringify(['', '', '', true, false]));
  const slug = SkillParser.slug(name);
  const valid = name.trim() !== '' && description.trim() !== '' && instructions.trim() !== '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await app.skills.save({ id, name, description, instructions, resources, enabled, alwaysOn, sourceUrl });
      toast(t('Saved {name}.', { name: s.name }));
      back();
    } catch (e) {
      setError(errorText(e, t('Couldn’t save the skill. Try again.')));
      setBusy(false);
    }
  };

  // Escape normally leaves the page; with unsaved changes, ask first.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dirty && !confirm && !viewing) {
      e.stopPropagation();
      setConfirm('leave');
    }
  };

  if (missing) {
    return (
      <div className="col gap-16 tools-page">
        <ToolsStatus tone="info">{t('This skill was deleted.')}</ToolsStatus>
        <span>
          <Button variant="tonal" onClick={back}>{t('Back to Tools')}</Button>
        </span>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="tools-page" style={{ padding: 24 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className="col gap-16 tools-page" onKeyDown={onKeyDown}>
      <ToolsSubhead title={id ? t('Edit skill') : t('New skill')} />
      <Field
        label={t('Name')}
        hint={sentences(
          t('Lowercase words joined by hyphens. Models refer to the skill by this name.'),
          name.trim() && slug !== name.trim() ? t('Saved as “{name}”.', { name: slug }) : null,
        )}
      >
        <input className="input mono" dir="ltr" value={name} placeholder={t('e.g. {name}', { name: 'meeting-notes' })} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label={t('When to use it')}
        hint={description.length > 900 ? t('{count} of {max} characters.', { count: description.length, max: 1024 }) : t('Models read this to decide when to load the skill. Be specific.')}
      >
        <textarea
          className="textarea"
          dir="auto"
          rows={3}
          value={description}
          maxLength={1024}
          placeholder={t('Turn rough notes into structured meeting notes. Use when the user shares notes or a transcript.')}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label={t('Instructions')} hint={t('Markdown: steps, formats, checklists and examples.')}>
        <textarea
          className="textarea tools-code-input"
          dir="auto"
          rows={14}
          value={instructions}
          placeholder={t('Step-by-step instructions, formats, checklists, examples…')}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>

      <div className="group">
        <SwitchRow
          icon={<Power size={20} />}
          title={t('Use this skill')}
          subtitle={enabled ? t('Models load it when a task calls for it.') : t('Off: models don’t see it.')}
          checked={enabled}
          onChange={setEnabled}
        />
        <Divider />
        <SwitchRow
          icon={<InfinityIcon size={20} />}
          title={t('Always on')}
          subtitle={t('Include the full instructions in every chat instead of loading them when needed. Uses more tokens.')}
          checked={alwaysOn}
          onChange={setAlwaysOn}
        />
      </div>

      {resources.length > 0 && (
        <Group title={t('Bundled files ({count})', { count: resources.length })} footer={t('Files that came with the skill. Models can read them while they use it.')}>
          {resources.map((r, i) => (
            <div key={r.path}>
              {i > 0 && <Divider />}
              <Row
                icon={<FileText size={20} />}
                title={<span className="mono" dir="ltr" style={{ fontSize: 13.5 }}>{r.path}</span>}
                subtitle={tn('{count} character', '{count} characters', r.content.length)}
                onClick={() => setViewing(r)}
              />
            </div>
          ))}
        </Group>
      )}

      {sourceUrl && <p className="field-hint ellipsis" style={{ margin: '0 6px' }} title={sourceUrl}>{t('Imported from {url}', { url: sourceUrl })}</p>}
      {error && <ToolsStatus tone="error">{error}</ToolsStatus>}

      <div className="tools-form-actions">
        <Button busy={busy} disabled={!valid} onClick={save}>{t('Save skill')}</Button>
        <Button variant="text" onClick={back}>{t('Cancel')}</Button>
        <span className="grow" />
        {id && (
          <Button variant="danger" onClick={() => setConfirm('delete')}>
            <Trash2 size={16} /> {t('Delete')}
          </Button>
        )}
      </div>

      {viewing && (
        <Dialog title={<span className="mono" dir="ltr">{viewing.path}</span>} onClose={closeViewer} size="wide">
          <div className="code-box" dir="auto" style={{ maxHeight: '60vh' }}>{viewing.content}</div>
        </Dialog>
      )}
      {confirm === 'delete' && id && (
        <Confirm
          title={t('Delete this skill?')}
          body={t('It’s removed from all your devices.')}
          confirm={t('Delete')}
          danger
          onConfirm={async () => {
            await app.skills.delete(id);
            toast(t('Deleted {name}.', { name }));
            back();
          }}
          onClose={closeConfirm}
        />
      )}
      {confirm === 'leave' && (
        <Confirm title={t('Discard changes?')} body={t('Your edits to this skill aren’t saved.')} confirm={t('Discard')} danger onConfirm={back} onClose={closeConfirm} />
      )}
    </div>
  );
}
