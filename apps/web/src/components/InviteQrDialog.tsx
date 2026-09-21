import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { ApiError } from '@banana-chat/api-client';
import type { WorkspaceInvite } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useChatText } from '../lib/use-chat-text';
import { Avatar, Icon } from './Visual';

type Status = 'idle' | 'checking' | 'creating' | 'ready' | 'revoke-confirm' | 'revoking' | 'revoked' | 'expired' | 'consumed' | 'error';

const TERMINAL_STATUS: Record<string, Status> = {
  INVITE_EXPIRED: 'expired',
  INVITE_REVOKED: 'revoked',
  INVITE_ALREADY_USED: 'consumed',
  INVITE_NOT_FOUND: 'consumed',
};

/**
 * FR-WS-006 / DEC-081 — owner/admin issues a one-time invite QR. `invite` is
 * owned by AppShell (keyed to the current workspace, cleared on logout/switch)
 * so reopening the menu shows the still-live invite instead of minting a new
 * one; the token/join_url only ever come back from the issue call, never
 * refetchable, so a reload genuinely loses it (no recovery to imply).
 */
export function InviteQrDialog({
  slug,
  workspaceName,
  invite,
  onIssued,
  onRevoked,
  onClose,
}: {
  slug: string;
  workspaceName: string;
  invite: WorkspaceInvite | null;
  onIssued: (invite: WorkspaceInvite) => void;
  onRevoked: () => void;
  onClose: () => void;
}) {
  const { text } = useChatText();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>(invite !== null ? 'checking' : 'idle');
  const [copyLabel, setCopyLabel] = useState(() => text('invite.copyLink'));
  const [remaining, setRemaining] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  // A cached invite (from a previous open of this dialog) may have been used
  // or revoked from elsewhere in the meantime — revalidate against the
  // public preview endpoint before ever showing it as scannable again.
  useEffect(() => {
    if (invite === null) return;
    let cancelled = false;
    endpoints.joinInvitePreview(invite.token)
      .then(() => { if (!cancelled) setStatus('ready'); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus(e instanceof ApiError ? (TERMINAL_STATUS[e.code] ?? 'error') : 'error');
      });
    return () => { cancelled = true; };
  }, [invite]);

  useEffect(() => {
    if (invite === null || (status !== 'ready' && status !== 'revoke-confirm' && status !== 'revoking') || canvasRef.current === null) return;
    void QRCode.toCanvas(canvasRef.current, invite.join_url, { width: 240, margin: 2, color: { dark: '#202b36', light: '#ffffff' } });
  }, [status, invite]);

  useEffect(() => {
    if (invite === null) return;
    const expiresAt = new Date(invite.expires_at).getTime();
    const update = () => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        setStatus(current => (current === 'revoked' ? current : 'expired'));
        setRemaining('');
        return;
      }
      const totalMinutes = Math.floor(ms / 60_000);
      if (totalMinutes < 1) { setRemaining(text('invite.expiresUnderMinute')); return; }
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const time = hours > 0
        ? text('invite.timeHoursMinutes').replace('{h}', String(hours)).replace('{m}', String(minutes))
        : text('invite.timeMinutes').replace('{m}', String(minutes));
      setRemaining(text('invite.expiresIn').replace('{time}', time));
    };
    update();
    const id = window.setInterval(update, 60_000);
    return () => window.clearInterval(id);
  }, [invite, text]);

  const generate = useCallback(async () => {
    setStatus('creating');
    try {
      const created = await endpoints.createWorkspaceInvite(slug);
      onIssued(created);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [slug, onIssued]);

  const copy = useCallback(async () => {
    if (invite === null) return;
    try {
      await navigator.clipboard.writeText(invite.join_url);
      setCopyLabel(text('invite.copied'));
      window.setTimeout(() => setCopyLabel(text('invite.copyLink')), 2000);
    } catch {
      setCopyLabel(text('invite.copyFailed'));
    }
  }, [invite, text]);

  const revoke = useCallback(async () => {
    if (invite === null) return;
    setStatus('revoking');
    setRevokeError(null);
    try {
      await endpoints.revokeWorkspaceInvite(slug, invite.id);
      onRevoked();
      setStatus('revoked');
    } catch {
      // The link may still be usable — say so explicitly rather than
      // silently dropping back to "ready" as if nothing was attempted.
      setRevokeError(text('invite.revokeError'));
      setStatus('revoke-confirm');
    }
  }, [slug, invite, onRevoked, text]);

  const close = () => { dialogRef.current?.close(); onClose(); };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bc-message-menu bc-invite-dialog"
      data-testid="invite-qr-dialog"
      aria-labelledby="invite-dialog-title"
      onCancel={close}
      onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}
    >
      <div className="bc-message-menu-heading">
        <strong id="invite-dialog-title">{text('invite.title')}</strong>
        <button autoFocus className="bc-chat-control" aria-label={text('invite.close')} onClick={close}><Icon name="close" size={18} /></button>
      </div>

      <div className="bc-invite-workspace">
        <Avatar name={workspaceName} />
        <span>{workspaceName}</span>
      </div>

      {status === 'idle' && (
        <>
          <p className="bc-invite-hint">{text('invite.oneNewAccount')}</p>
          <button type="button" className="bc-invite-primary" onClick={() => void generate()}>{text('invite.generate')}</button>
        </>
      )}

      {status === 'checking' && (
        <div className="bc-invite-qr-placeholder" aria-hidden="true" />
      )}

      {status === 'consumed' && (
        <>
          <p className="bc-invite-hint">{text('invite.consumed')}</p>
          <button type="button" className="bc-invite-primary" onClick={() => void generate()}>{text('invite.generate')}</button>
        </>
      )}

      {status === 'creating' && (
        <>
          <div className="bc-invite-qr-placeholder" aria-hidden="true" />
          <p className="bc-invite-hint" role="status">{text('invite.creating')}</p>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="bc-invite-error" role="alert">{text('invite.createError')}</p>
          <button type="button" className="bc-invite-primary" onClick={() => void generate()}>{text('invite.generate')}</button>
        </>
      )}

      {status === 'expired' && (
        <>
          <p className="bc-invite-hint">{text('invite.expired')}</p>
          <button type="button" className="bc-invite-primary" onClick={() => void generate()}>{text('invite.generate')}</button>
        </>
      )}

      {status === 'revoked' && (
        <>
          <p className="bc-invite-hint">{text('invite.revoked')}</p>
          <div className="bc-invite-actions">
            <button type="button" className="bc-invite-primary" onClick={() => void generate()}>{text('invite.generate')}</button>
            <button type="button" onClick={close}>{text('invite.close')}</button>
          </div>
        </>
      )}

      {(status === 'ready' || status === 'revoke-confirm' || status === 'revoking') && invite !== null && (
        <>
          <figure className="bc-invite-qr">
            <canvas ref={canvasRef} width={240} height={240} />
            <figcaption>{text('invite.scanToJoin')}</figcaption>
          </figure>
          <p className="bc-invite-hint">{text('invite.oneNewAccount')}</p>
          <p className="bc-invite-expiry">{remaining}</p>
          <label className="bc-invite-link-label" htmlFor="invite-join-url">{text('invite.linkLabel')}</label>
          <div className="bc-invite-link-row">
            <input id="invite-join-url" readOnly value={invite.join_url} onFocus={event => event.currentTarget.select()} />
            <button type="button" onClick={() => void copy()} aria-live="polite">{copyLabel}</button>
          </div>
          <p className="bc-invite-hint">{text('invite.closeExplanation')}</p>

          {status === 'revoke-confirm' && (
            <div className="bc-invite-revoke-confirm" role="alertdialog" aria-label={text('invite.revokeConfirmTitle')}>
              <p><strong>{text('invite.revokeConfirmTitle')}</strong> {text('invite.revokeConfirmBody')}</p>
              {revokeError !== null && <p className="bc-invite-error" role="alert">{revokeError}</p>}
              <div className="bc-invite-actions">
                <button type="button" onClick={() => { setRevokeError(null); setStatus('ready'); }}>{text('invite.keepLink')}</button>
                <button type="button" className="is-destructive" onClick={() => void revoke()}>{text('invite.confirmRevoke')}</button>
              </div>
            </div>
          )}

          {status === 'ready' && (
            <div className="bc-invite-actions">
              <button type="button" className="is-destructive" onClick={() => setStatus('revoke-confirm')}>{text('invite.revoke')}</button>
              <button type="button" onClick={close}>{text('invite.close')}</button>
            </div>
          )}

          {status === 'revoking' && (
            <div className="bc-invite-actions">
              <button type="button" className="is-destructive" disabled>{text('invite.confirmRevoke')}…</button>
            </div>
          )}
        </>
      )}
    </dialog>,
    document.body,
  );
}
