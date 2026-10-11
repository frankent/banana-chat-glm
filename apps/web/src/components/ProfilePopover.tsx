import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { RoomRosterMember, UserStub } from '@banana-chat/shared';
import { classifyDmError, type DmFailureKind } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';
import { useChatText } from '../lib/use-chat-text';
import { useSession } from '../state/session';
import { Avatar, Icon } from './Visual';
import '../avatar.css';
import '../profile-popover.css';

type DmState = 'idle' | 'unavailable' | 'self' | 'forbidden' | 'network' | 'generic';
const ERROR_KEY: Record<Exclude<DmState, 'idle' | 'unavailable' | 'self'>, string> = {
  forbidden: 'profile.errForbidden', network: 'profile.errNetwork', generic: 'profile.errGeneric',
};

/**
 * FR-PROF-009 / DEC-101 — profile card for a message sender with a "Chat 1-1" action.
 * One instance, owned by ChatView. Modal <dialog>: card next to the avatar on wide
 * screens, bottom sheet on <=760px. Closing always wins over an in-flight request.
 */
export function ProfilePopover({ user, roster, isSelf, returnFocusTo, anchorRect, slug, existingDmRoomId, onClose, onNavigate }: {
  user: UserStub;
  roster?: RoomRosterMember;
  isSelf: boolean;
  returnFocusTo: HTMLElement | null;
  anchorRect: DOMRect | null;
  slug: string;
  existingDmRoomId: string | null;
  onClose: () => void;
  onNavigate: (roomId: string) => void;
}) {
  const { text, locale } = useChatText();
  const queryClient = useQueryClient();
  const nameId = useId();
  const metaId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<DmState>(isSelf ? 'self' : 'idle');

  const close = () => {
    if (cancelledRef.current) return;
    cancelledRef.current = true;
    dialogRef.current?.close();
    onClose();
    const back = returnFocusTo;
    if (back?.isConnected) window.requestAnimationFrame(() => back.focus());
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);

  const place = () => {
    const dialog = dialogRef.current;
    if (!dialog || !window.matchMedia('(min-width: 761px)').matches) return;
    const { innerWidth: vw, innerHeight: vh } = window;
    const w = dialog.offsetWidth;
    const h = dialog.offsetHeight;
    const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));
    let left = (vw - w) / 2;
    let top = (vh - h) / 2;
    if (anchorRect) {
      left = anchorRect.right + 8 + w <= vw - 8 ? anchorRect.right + 8 : anchorRect.left - w - 8;
      top = anchorRect.top - 8;
    }
    dialog.style.setProperty('--pp-x', `${clamp(left, vw - w - 8)}px`);
    dialog.style.setProperty('--pp-y', `${clamp(top, vh - h - 8)}px`);
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-testid=profile-dm-button]")?.focus();
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDm = async () => {
    if (busyRef.current || cancelledRef.current) return;
    busyRef.current = true;
    if (existingDmRoomId) {
      onNavigate(existingDmRoomId);
      close();
      return;
    }
    setBusy(true);
    setState('idle');
    try {
      const result = await endpoints.createDm(user.id, slug);
      if (cancelledRef.current || useSession.getState().currentWorkspace?.workspace.slug !== slug) return;
      await queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      if (cancelledRef.current) return;
      onNavigate(result.room.id);
      close();
    } catch (error) {
      if (cancelledRef.current) return;
      const kind: DmFailureKind = classifyDmError(error);
      setState(kind);
    } finally {
      busyRef.current = false;
      if (!cancelledRef.current) setBusy(false);
    }
  };

  const presence = roster?.presence;
  const roleKey = roster?.role === 'owner' ? 'profile.roleOwner' : roster?.role === 'admin' ? 'profile.roleAdmin' : null;
  const hasMeta = presence !== undefined || roleKey !== null;
  const showButton = !isSelf && state !== 'unavailable' && state !== 'self';
  const errorKey = state === 'forbidden' || state === 'network' || state === 'generic' ? ERROR_KEY[state] : null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bc-avatar-editor bc-profile-pop"
      data-testid="profile-popover"
      aria-labelledby={nameId}
      aria-describedby={hasMeta ? metaId : undefined}
      aria-busy={busy}
      lang={locale}
      onCancel={event => { event.preventDefault(); closeRef.current(); }}
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) close();
      }}
    >
      <button type="button" className="bc-ae-icon-button bc-pp-close" aria-label={text('profile.close')} onClick={close}><Icon name="close" size={18} /></button>
      <div className="bc-pp-head">
        <Avatar name={user.display_name} avatar={user.avatar} large className="bc-pp-avatar" />
        <h2 id={nameId} className="bc-pp-name" title={user.display_name}>{user.display_name}</h2>
        <p className="bc-pp-username">@{user.username}</p>
        {hasMeta && (
          <p id={metaId} className="bc-pp-meta">
            {presence !== undefined && <span className={`bc-pp-presence is-${presence}`} data-testid="profile-presence"><i aria-hidden="true" />{text(presence === 'online' ? 'profile.online' : 'profile.offline')}</span>}
            {roleKey && <span className="bc-pp-role">{text(roleKey)}</span>}
          </p>
        )}
      </div>
      {isSelf && <p className="bc-pp-note">{text('profile.self')}</p>}
      {state === 'unavailable' && <p className="bc-pp-note" role="alert" data-testid="profile-unavailable">{text('profile.unavailable')}</p>}
      {showButton && (
        <button type="button" className="bc-ae-button is-primary bc-pp-dm" data-testid="profile-dm-button" disabled={busy} aria-disabled={busy} onClick={() => void startDm()}>
          {text(busy ? 'profile.dmOpening' : 'profile.dm')}
        </button>
      )}
      {errorKey && <p className="bc-pp-error" role="alert" data-testid="profile-dm-error">{text(errorKey)}</p>}
    </dialog>,
    document.body,
  );
}
