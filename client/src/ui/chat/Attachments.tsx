import { Download, FileText, File as FileIcon, Music, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import type { AttachmentRef } from '../../data/entities';
import { platform } from '../../platform';
import { IconButton, useToast } from '../components/primitives';
import { useAttachmentUrl } from '../hooks';

/** Opens or saves an attachment, downloading it from sync storage first if needed. */
export async function saveAttachment(ref: AttachmentRef, toast: (t: string) => void): Promise<void> {
  const app = getApp();
  const ok = await app.sync.ensureLocal(ref.id);
  const blob = ok ? await app.attachments.blob(ref.id) : null;
  if (!blob) {
    const a = await app.attachments.get(ref.id);
    toast(a?.uploaded === false ? 'This file is only on another of your devices.' : 'This file isn’t on this device yet.');
    return;
  }
  await platform().saveFile(ref.name, blob);
}

export function FileChip({ att, onClick, trailing }: { att: AttachmentRef; onClick?: () => void; trailing?: React.ReactNode }) {
  const isPdf = att.kind === 'pdf';
  const ext = att.name.includes('.') ? att.name.slice(att.name.lastIndexOf('.') + 1).toUpperCase() : 'File';
  return (
    <button type="button" className="file-chip" onClick={onClick} title={att.name}>
      <span className={'ic' + (isPdf ? ' pdf' : '')}>{isPdf ? <FileText size={17} /> : att.kind === 'audio' ? <Music size={17} /> : <FileIcon size={17} />}</span>
      <span className="col" style={{ minWidth: 0 }}>
        <span className="t-label-m ellipsis">{att.name}</span>
        <span className="t-label-s c-3" style={{ fontWeight: 400 }}>{(isPdf ? 'PDF' : ext) + ' · ' + Format.bytes(att.sizeBytes)}</span>
      </span>
      {trailing}
    </button>
  );
}

export function ImageThumb({ att, width, onOpen }: { att: AttachmentRef; width: number; onOpen: (url: string) => void }) {
  const { url, missing } = useAttachmentUrl(att.id);
  const ratio = att.width && att.height ? Math.min(2, Math.max(0.5, att.width / att.height)) : 1;
  return (
    <button type="button" className="attach-img" style={{ width, height: Math.round(width / ratio) }} onClick={() => url && onOpen(url)} aria-label={`Open ${att.name}`}>
      {url ? <img src={url} alt={att.name} loading="lazy" /> : missing ? <span className="t-label-s c-3" style={{ padding: 10, display: 'block' }}>Not on this device</span> : null}
    </button>
  );
}

function VideoView({ att }: { att: AttachmentRef }) {
  const { url, missing } = useAttachmentUrl(att.id);
  if (missing) return <FileChip att={att} />;
  return url ? <video className="media-video" src={url} controls preload="metadata" style={att.width && att.height ? { aspectRatio: `${att.width} / ${att.height}` } : undefined} /> : null;
}

function AudioView({ att }: { att: AttachmentRef }) {
  const toast = useToast();
  const { url, missing } = useAttachmentUrl(att.id);
  if (missing) return <FileChip att={att} />;
  return (
    <div className="media-audio">
      <Music size={18} className="c-2" />
      {url && <audio src={url} controls preload="metadata" />}
      <IconButton label="Save" small onClick={() => saveAttachment(att, toast)}>
        <Download size={16} />
      </IconButton>
    </div>
  );
}

/** Attachments of a message: images as thumbnails, media players, other files as chips. */
export function AttachmentStrip({ atts, align = 'end' }: { atts: AttachmentRef[]; align?: 'end' | 'start' }) {
  const toast = useToast();
  const [lightbox, setLightbox] = useState<{ url: string; att: AttachmentRef } | null>(null);
  const images = atts.filter((a) => a.kind === 'image');
  return (
    <>
      <div className={'attach-strip' + (align === 'start' ? ' left' : '')}>
        {atts.map((a) => {
          if (a.kind === 'image') return <ImageThumb key={a.id} att={a} width={images.length === 1 ? (align === 'start' ? 360 : 240) : 130} onOpen={(url) => setLightbox({ url, att: a })} />;
          if (a.kind === 'video') return <VideoView key={a.id} att={a} />;
          if (a.kind === 'audio') return <AudioView key={a.id} att={a} />;
          return <FileChip key={a.id} att={a} onClick={() => saveAttachment(a, toast)} />;
        })}
      </div>
      {lightbox && <Lightbox url={lightbox.url} att={lightbox.att} onClose={() => setLightbox(null)} />}
    </>
  );
}

export function Lightbox({ url, att, onClose }: { url: string; att: AttachmentRef; onClose: () => void }) {
  const toast = useToast();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <img src={url} alt={att.name} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <IconButton label="Save image" onClick={() => saveAttachment(att, toast)}>
          <Download size={20} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
    </div>,
    document.body,
  );
}
