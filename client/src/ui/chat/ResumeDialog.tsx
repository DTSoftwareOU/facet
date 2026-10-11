/** Pick a Claude Code or Codex session from the chat's folder and continue it in a new chat. */
import { MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dates } from '../../core/format';
import { AGENT_NAMES } from '../../domain/resume';
import type { AgentKind, AgentSessionSummary } from '../../platform/platform';
import type { ChatComputer } from '../../remote/computers';
import { Button, Dialog, Divider, Group, Row, Spinner } from '../components/primitives';
import { folderName } from './ComputerDialog';

export function ResumeDialog({ agent, computer, onResume, onClose }: {
  agent: AgentKind;
  computer: ChatComputer;
  /** Imports the session and opens the new chat; rejects with a message to show. */
  onResume: (sessionId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const name = AGENT_NAMES[agent];

  useEffect(() => {
    let live = true;
    setSessions(null);
    setError(null);
    computer
      .agentSessions(agent)
      .then((list) => live && setSessions(list))
      .catch((e: Error) => live && setError(e.message || `Couldn’t list ${name} sessions.`));
    return () => {
      live = false;
    };
  }, [agent, computer.hostId, computer.folder, attempt]);

  const open = async (id: string) => {
    setOpening(id);
    setError(null);
    try {
      await onResume(id);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Couldn’t open that session.');
      setOpening(null);
    }
  };

  return (
    <Dialog
      title={`Continue a ${name} session`}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          {error && sessions === null && <Button variant="text" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
          <span className="grow" />
          <Button variant="tonal" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="t-body c-2" style={{ margin: '0 0 14px' }}>
        Sessions in <strong title={computer.folder}>{folderName(computer.folder)}</strong>
        {computer.local ? '' : ` on ${computer.name}`}. The one you pick opens as a new chat with the model you’ve chosen.
      </p>
      {error && <p className="field-error" role="alert" style={{ margin: '0 4px 12px' }}>{error}</p>}
      {sessions === null && !error && (
        <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
          <Spinner />
        </div>
      )}
      {sessions && sessions.length === 0 && (
        <p className="t-body c-3" style={{ margin: '8px 4px 4px' }}>No {name} sessions in this folder.</p>
      )}
      {sessions && sessions.length > 0 && (
        <Group>
          {sessions.map((s, i) => (
            <div key={s.id}>
              {i > 0 && <Divider />}
              <Row
                icon={<MessagesSquare size={20} />}
                title={s.title || 'Untitled session'}
                subtitle={`${Dates.relative(s.updatedAt)} · ${s.messageCount} ${s.messageCount === 1 ? 'message' : 'messages'}`}
                onClick={opening ? undefined : () => void open(s.id)}
                trailing={opening === s.id ? <Spinner size={16} /> : undefined}
                disabled={!!opening && opening !== s.id}
              />
            </div>
          ))}
        </Group>
      )}
    </Dialog>
  );
}
