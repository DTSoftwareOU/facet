import { ArrowLeft, MessageSquare, Search } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { getApp } from '../app';
import { Dates } from '../core/format';
import type { SearchHit } from '../data/conversations';
import type { ConversationEntity } from '../data/entities';
import { t } from '../i18n';
import { IconButton } from './components/primitives';
import { navigate } from './nav';

/** Renders "[[match]]" spans from a snippet as highlighted text. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  return (
    <span className="srow-sub">
      <bdi>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="hit">{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</bdi>
    </span>
  );
}

export function SearchScreen() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ titles: ConversationEntity[]; hits: SearchHit[] } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      void getApp().conversations.search(q).then(setResult);
    }, 150);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <div className="main">
      <header className="topbar">
        <IconButton label={t('Back')} onClick={() => history.back()}>
          <ArrowLeft size={20} className="flip-rtl" />
        </IconButton>
        <div className="row grow search-box">
          <Search size={18} className="c-3" />
          <input
            autoFocus
            dir="auto"
            className="input"
            placeholder={t('Search all chats')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && history.back()}
            aria-label={t('Search all chats')}
          />
        </div>
      </header>
      <div className="thread">
        <div className="thread-inner" style={{ paddingTop: 0 }}>
          {!q.trim() && <div className="empty"><div className="empty-icon"><Search size={24} /></div><span className="t-body">{t('Search titles and messages in every chat.')}</span></div>}
          {result && q.trim() && result.titles.length === 0 && result.hits.length === 0 && <div className="empty t-body">{t('Nothing matches “{query}”.', { query: q })}</div>}
          {result && result.titles.length > 0 && (
            <>
              <h3 className="group-title">{t('Chats')}</h3>
              <div className="group">
                {result.titles.map((c) => (
                  <button key={c.id} type="button" className="srow" onClick={() => navigate({ name: 'chat', id: c.id })}>
                    <span className="srow-icon"><MessageSquare size={18} /></span>
                    <span className="srow-text">
                      <span className="srow-title ellipsis"><bdi>{c.title}</bdi></span>
                      <span className="srow-sub">{Dates.short(c.lastActivityAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {result && result.hits.length > 0 && (
            <>
              <h3 className="group-title">{t('Messages')}</h3>
              <div className="group">
                {result.hits.map((h) => (
                  <button key={h.messageId} type="button" className="srow" onClick={() => navigate({ name: 'chat', id: h.conversationId })}>
                    <span className="srow-text">
                      <span className="srow-title ellipsis">
                        {h.title ? <bdi>{h.title}</bdi> : t('Chat')}{' '}
                        <span className="c-3 t-label-s">· {h.role === 'user' ? t('You') : t('Reply')} · {Dates.short(h.createdAt)}</span>
                      </span>
                      <Snippet text={h.snippet} />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
