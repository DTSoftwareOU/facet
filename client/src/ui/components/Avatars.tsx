import { Code, GraduationCap, Languages, LineChart, PenLine } from 'lucide-react';
import { DEFAULT_ASSISTANT_ID, type Assistant } from '../../data/library';
import { Gem } from './Gem';

export const ACCENTS = ['#49D3C1', '#6E9BFF', '#F2C66D', '#FF8F8F', '#B98CFF', '#5BD69B', '#F2994A', '#A3ACBA'];

export function accent(index: number): string {
  return ACCENTS[((index % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
}

const ICONS = { code: Code, writer: PenLine, tutor: GraduationCap, languages: Languages, analyst: LineChart } as const;

export function AssistantAvatar({ assistant, size = 32 }: { assistant: Assistant; size?: number }) {
  if (assistant.id === DEFAULT_ASSISTANT_ID) {
    return (
      <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <Gem size={Math.round(size * 0.78)} />
      </span>
    );
  }
  const tint = accent(assistant.colorIndex);
  const Icon = assistant.icon && assistant.icon !== 'gem' ? ICONS[assistant.icon] : null;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        background: `color-mix(in srgb, ${tint} 20%, transparent)`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        color: tint,
        fontSize: size * 0.5,
        lineHeight: 1,
      }}
    >
      {Icon ? <Icon size={Math.round(size * 0.55)} /> : assistant.emoji}
    </span>
  );
}

export function UserAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initial}
    </span>
  );
}

/** A provider's initial on a tinted square (used in model pickers). */
export function ProviderBadge({ name, size = 22 }: { name: string; size?: number }) {
  const palette = ['#F2994A', '#6E9BFF', '#49D3C1', '#B98CFF', '#F2C66D', '#FF8F8F', '#5BD69B'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const tint = palette[h % palette.length];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: `color-mix(in srgb, ${tint} 22%, transparent)`,
        color: tint,
        fontSize: size * 0.48,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
