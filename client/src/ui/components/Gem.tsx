/**
 * The Facet gem (docs/DESIGN.md "Logo"): a princess-cut stone seen from above. It is the logo,
 * the thinking indicator and the streaming cursor. While thinking, the facet colors turn one
 * position clockwise every 400 ms and the table breathes; with reduced motion it stays still.
 */
import type { CSSProperties } from 'react';

const FACETS = [
  { points: '4,50 50,4 50,32 32,50', color: 'var(--gold)', delay: 0 },
  { points: '50,4 96,50 68,50 50,32', color: 'var(--flash)', delay: -1.2 },
  { points: '96,50 50,96 50,68 68,50', color: 'var(--deep)', delay: -0.8 },
  { points: '50,96 4,50 32,50 50,68', color: 'var(--glint)', delay: -0.4 },
];

export function Gem({ size = 24, thinking = false, className, style, title }: {
  size?: number;
  thinking?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={'gem' + (thinking ? ' thinking' : '') + (className ? ' ' + className : '')}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {FACETS.map((f) => (
        <polygon key={f.points} points={f.points} fill={f.color} style={thinking ? { animationDelay: `${f.delay}s` } : undefined} className="gem-facet" />
      ))}
      <polygon points="50,32 68,50 50,68 32,50" className="gem-table" fill="var(--gem-table)" stroke="var(--gem-outline)" strokeWidth="1.2" />
    </svg>
  );
}
