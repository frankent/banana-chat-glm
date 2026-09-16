/**
 * FR-PCHAT — presentation primitives shared by the two agent surfaces and the
 * public visitor page.
 *
 * MANDATORY fix 20: customer_name, provider_name and every message body on this
 * feature are attacker-controlled (they come from the partner's own site and
 * from an unauthenticated visitor). Everything here renders them as TEXT NODES.
 * There is no Markdown renderer and no dangerouslySetInnerHTML anywhere in this
 * file, and none may be added — `MarkdownEditor`/`renderMarkdown` are for
 * internal workspace messages only.
 */
import { publicChatStatusLabelKey, publicChatStatusTone } from '@banana-chat/chat-core';
import { t } from '@banana-chat/shared';
import type { Attachment, Locale, PublicChatStatus, PublicChatStatusPublic } from '@banana-chat/shared';
import { Icon } from './Visual';

/** The internal triage status. AGENT SURFACES ONLY — never the visitor page. */
export function PcStatusPill({ status }: { status: PublicChatStatus }) {
  return (
    <span className={`bc-pchat-pill tone-${publicChatStatusTone(status)}`}>
      {t(publicChatStatusLabelKey(status), 'en')}
    </span>
  );
}

/**
 * The only status a customer may ever see (MANDATORY graft 1): `problem`
 * collapses into `open` exactly like `new` and `in_progress`.
 */
export function PcPublicStatusPill({ status, locale }: { status: PublicChatStatusPublic; locale: Locale }) {
  return <span className={`bc-pchat-pill tone-${status === 'open' ? 'info' : 'ok'}`}>{t(`pchat.statusPublic.${status}`, locale)}</span>;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachments on a support transcript. Image / video / file only — this context
 * has no call or meeting media, and `original_name` is customer-supplied, so it
 * is a text node with no link text substitution.
 */
export function PcAttachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="bc-pchat-attachments">
      {attachments.map((attachment) => {
        const ready = attachment.status === 'ready';
        if (attachment.kind === 'image' && ready && attachment.urls.thumb_md !== null) {
          return (
            <a key={attachment.id} href={attachment.urls.original ?? attachment.urls.thumb_md} target="_blank" rel="noreferrer noopener">
              <img src={attachment.urls.thumb_md} alt={attachment.original_name} loading="lazy" />
            </a>
          );
        }
        if (attachment.kind === 'video' && ready && attachment.urls.original !== null) {
          return (
            <video key={attachment.id} src={attachment.urls.original} poster={attachment.urls.poster ?? undefined} controls preload="metadata" />
          );
        }
        return (
          <a
            key={attachment.id}
            className="bc-pchat-file"
            href={ready ? (attachment.urls.original ?? '#') : '#'}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!ready}
            onClick={(event) => {
              if (!ready) event.preventDefault();
            }}
          >
            <Icon name="files" size={16} />
            <span>{attachment.original_name}</span>
            <small>{ready ? human(attachment.size_bytes) : 'processing…'}</small>
          </a>
        );
      })}
    </div>
  );
}

/** Quoted parent (MANDATORY graft 4) — snippet only, never an author. */
export function PcReplyQuote({ snippet, locale = 'en' }: { snippet: string | null; locale?: Locale }) {
  return <p className="bc-pchat-quote">{snippet ?? t('pchat.message.deleted', locale)}</p>;
}
