import { useEffect, useRef, useState } from 'react';
import { useChatText } from '../../lib/use-chat-text';
import { useLinkPreview } from '../../hooks/useLinkPreview';
import '../../styles/external-link-card.css';

/**
 * FR-MSG-013 / DEC-100 / B5.6 — preview card for an EXTERNAL link (API-241).
 * Props are the frozen contract MessageLinkCard (S3) imports.
 * Renders nothing until the preview is ready (the plain link in the message
 * body remains). All fields are text nodes; the image is only ever our own
 * re-encoded copy (`image_url`), never the third-party og:image.
 */
export function ExternalLinkCard({ url }: { url: string }) {
  const { text } = useChatText();
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const state = useLinkPreview(url, visible);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (el === null) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const p = state.kind === 'ready' ? state.preview : null;
  useEffect(() => { setImageFailed(false); }, [p?.image_url]);

  return (
    <div ref={ref} className="elc-root">
      {p !== null && (
        <a
          className="elc-card"
          data-testid="link-preview-card"
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={`${text('chat.linkPreviewOpen')}: ${p.title ?? p.site_name ?? url}`}
        >
          {p.image_url && !imageFailed && (
            <img
              className="elc-image"
              data-testid="link-preview-image"
              src={p.image_url}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
            />
          )}
          <span className="elc-body">
            {p.site_name && <span className="elc-site" data-testid="link-preview-site">{p.site_name}</span>}
            {p.title && <span className="elc-title" data-testid="link-preview-title">{p.title}</span>}
            {p.description && <span className="elc-desc" data-testid="link-preview-description">{p.description}</span>}
          </span>
        </a>
      )}
    </div>
  );
}
