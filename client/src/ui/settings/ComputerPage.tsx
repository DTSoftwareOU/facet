/** Settings → Computer access (Windows app): let models run commands and work with files in a chat's working folder. */
import { FileText, FolderOpen, FolderSearch, Monitor, Power, Server, Terminal, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getApp } from '../../app';
import type { ToolApprovalName } from '../../data/prefs';
import { platform, type ComputerBridge, type ComputerInfo, type ComputerToolInfo } from '../../platform';
import { Button, Divider, Group, Spinner, SwitchRow, useToast } from '../components/primitives';
import { useLocalPrefs, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import type { PageProps } from './SettingsDialog';
import { ToolsRow, ToolsStatus, errorText, firstSentence } from './ToolsShared';

const CHOICES: { id: ToolApprovalName; title: string; subtitle: string }[] = [
  { id: 'ALWAYS', title: 'Ask before every action', subtitle: 'Even reading a file or listing a folder waits for you.' },
  { id: 'WRITES', title: 'Ask before commands and file changes', subtitle: 'Reading and searching files runs without asking. Recommended.' },
  { id: 'NEVER', title: 'Never ask', subtitle: 'Only for folders you trust. Commands run without asking and can reach anything your Windows account can.' },
];

function toolIcon(name: string) {
  if (/command|process/.test(name)) return <Terminal size={20} />;
  if (/grep|glob|directory/.test(name)) return <FolderSearch size={20} />;
  if (/file/.test(name)) return <FileText size={20} />;
  if (/open/.test(name)) return <FolderOpen size={20} />;
  return <Wrench size={20} />;
}

export function ComputerPage(_props: PageProps) {
  const computer = platform().computer;
  if (!computer) {
    return (
      <div className="col gap-16 tools-page">
        <div className="group computer-hero">
          <span className="onboard-icon"><Monitor size={20} /></span>
          <div className="col gap-6 grow">
            <span className="t-label-l">Computer access is part of the Windows app</span>
            <span className="t-body c-2">
              In the Facet app for Windows, models can run commands and read, write and edit files in a folder you choose. Every step shows in
              the reply, and steps that change things ask you first. Web browsers don’t give websites that kind of access.
            </span>
          </div>
        </div>
      </div>
    );
  }
  return <ComputerSettings computer={computer} />;
}

function ComputerSettings({ computer }: { computer: ComputerBridge }) {
  const app = getApp();
  const toast = useToast();
  const local = useLocalPrefs();
  const synced = useSyncedPrefs();
  const [info, setInfo] = useState<ComputerInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [tools, setTools] = useState<ComputerToolInfo[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const choiceRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    // The settings body keeps the previous page's scroll position.
    const body = document.querySelector<HTMLElement>('.settings-dialog .settings-body');
    if (body) body.scrollTop = 0;
  }, []);

  useEffect(() => {
    let live = true;
    computer.info().then(
      (i) => live && setInfo(i),
      (e) => live && setInfoError(errorText(e, 'Couldn’t read this computer’s details.')),
    );
    computer.tools().then(
      (t) => live && setTools(t),
      (e) => live && setToolsError(errorText(e, 'Couldn’t load the tools. Restart Facet and try again.')),
    );
    computer.defaultWorkspace().then(
      (w) => live && setFallback(w),
      () => live && setFallback(''),
    );
    return () => {
      live = false;
    };
  }, [computer]);

  const on = local.computerTools;
  const approval = local.computerApproval;
  const custom = local.defaultWorkspace.trim();
  const folder = custom || fallback || '';
  const shell = info?.shell || 'PowerShell';

  const setApproval = (a: ToolApprovalName) => app.settings.updateLocal((l) => ({ ...l, computerApproval: a }));
  const onChoiceKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CHOICES.length) % CHOICES.length;
    setApproval(CHOICES[next].id);
    choiceRefs.current[next]?.focus();
  };

  const changeFolder = async () => {
    try {
      const picked = await computer.pickFolder(folder || undefined);
      if (picked) app.settings.updateLocal((l) => ({ ...l, defaultWorkspace: picked }));
    } catch (e) {
      toast(errorText(e, 'Couldn’t open the folder picker.'));
    }
  };

  return (
    <div className="col gap-16 tools-page">
      <div className="group computer-hero">
        <span className="onboard-icon"><Monitor size={20} /></span>
        <div className="col gap-6 grow">
          <span className="t-label-l">Let models work on this computer</span>
          <span className="t-body c-2">
            Models that support tools can run {shell} commands and read, write and edit files in a chat’s working folder, the way coding
            agents like Claude Code do. Replies show every step, and risky steps ask you first.
          </span>
        </div>
      </div>

      <div className="group">
        <SwitchRow
          icon={<Power size={20} />}
          title="Let models use this computer"
          subtitle={on ? 'On for chats with tools. You can turn it off for one chat in its settings.' : 'Off in every chat.'}
          checked={on}
          onChange={(v) => app.settings.updateLocal((l) => ({ ...l, computerTools: v }))}
        />
      </div>

      <section className={on ? undefined : 'computer-dim'}>
        <h3 className="group-title" id="computer-ask">When to ask first</h3>
        <div className="group" role="radiogroup" aria-labelledby="computer-ask">
          {CHOICES.map((c, i) => {
            const selected = approval === c.id;
            return (
              <div key={c.id}>
                {i > 0 && <Divider />}
                <button
                  ref={(el) => {
                    choiceRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  className="srow computer-choice"
                  onClick={() => setApproval(c.id)}
                  onKeyDown={(e) => onChoiceKey(e, i)}
                >
                  <span className="srow-icon"><span className={'computer-radio' + (selected ? ' on' : '')} aria-hidden /></span>
                  <span className="srow-text">
                    <span className="srow-title">{c.title}</span>
                    <span className="srow-sub">{c.subtitle}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10 }}>
          {synced.yoloMode ? (
            <ToolsStatus
              tone="warning"
              action={
                <Button variant="text" small onClick={() => void app.settings.updateSynced((s) => ({ ...s, yoloMode: false }))}>
                  Turn off
                </Button>
              }
            >
              YOLO mode is on, so computer tools run without asking, whatever you choose here.
            </ToolsStatus>
          ) : (
            <p className="field-hint" style={{ margin: '0 6px' }}>YOLO mode (in Tools) skips all approvals, including these.</p>
          )}
        </div>
      </section>

      <Group title="Default working folder" footer="New chats work in this folder. Each chat can pick its own folder from the composer.">
        <div className="srow">
          <span className="srow-icon"><FolderOpen size={20} /></span>
          <span className="srow-text">
            <span className="srow-title mono computer-path">{folder || (fallback == null ? ' ' : 'No folder')}</span>
            <span className="srow-sub">{custom ? 'Chosen by you' : 'The default folder'}</span>
          </span>
        </div>
        <div className="tools-actions computer-folder-actions">
          <Button variant="tonal" small onClick={changeFolder}>Change…</Button>
          <Button
            variant="text"
            small
            disabled={!folder}
            onClick={() => void computer.open(folder).catch((e) => toast(errorText(e, 'Couldn’t open the folder.')))}
          >
            Open
          </Button>
          {custom && (
            <Button variant="text" small onClick={() => app.settings.updateLocal((l) => ({ ...l, defaultWorkspace: '' }))}>
              Reset
            </Button>
          )}
        </div>
      </Group>

      <Group
        title="What models can do"
        footer={
          approval === 'ALWAYS' ? 'Every tool asks before it runs.'
            : approval === 'NEVER' ? 'No tool asks before it runs.'
              : 'Tools that can change things ask before they run; tools that only read run without asking.'
        }
      >
        {toolsError && <div className="srow t-body c-error">{toolsError}</div>}
        {!tools && !toolsError && (
          <div className="srow">
            <Spinner />
          </div>
        )}
        {tools?.map((t, i) => (
          <div key={t.name}>
            {i > 0 && <Divider />}
            <div className="srow computer-tool">
              <span className="srow-icon">{toolIcon(t.name)}</span>
              <span className="srow-text">
                <span className="srow-title mono computer-tool-name">{t.name}</span>
                <span className="srow-sub">{firstSentence(t.description, 200)}</span>
              </span>
              {t.readOnly ? <span className="badge">Reads only</span> : <span className="badge warning">Can change things</span>}
            </div>
          </div>
        ))}
      </Group>

      <Group title="This computer">
        <div className="computer-info">
          {infoError ? (
            <span className="t-body c-error">{infoError}</span>
          ) : !info ? (
            <Spinner />
          ) : (
            <dl className="kv">
              <dt>System</dt>
              <dd>{info.os}</dd>
              <dt>Shell</dt>
              <dd>{info.shell}</dd>
              <dt>User</dt>
              <dd>{info.user}</dd>
              <dt>Computer name</dt>
              <dd>{info.hostname}</dd>
            </dl>
          )}
        </div>
      </Group>

      <div className="group">
        <ToolsRow
          icon={<Server size={20} />}
          title="Add local MCP servers"
          subtitle="Run MCP servers on this computer, like npx or uvx packages, and give models their tools."
          onClick={() => ui.openSettings('tools', 'mcp:add:local')}
        />
      </div>
    </div>
  );
}
