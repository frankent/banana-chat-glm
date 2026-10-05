import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError } from '@banana-chat/api-client';
import {
  AVATAR_MAX_ZOOM, AVATAR_MIME_TYPES, AVATAR_MIN_ZOOM, checkAvatarFile, clampCrop, cropCoverScale,
  cropOutputSize, cropSourceRect, panCrop, zoomCrop,
} from '@banana-chat/chat-core';
import type { AvatarCrop } from '@banana-chat/chat-core';
import type { UserAvatar } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { invalidatePeople } from '../lib/people-cache';
import { avatarText, roomAvatarText, workspaceAvatarText, type AvatarTextKey } from '../lib/avatar-text';
import { useChatText } from '../lib/use-chat-text';
import { AvatarUploadError, uploadAvatar } from '../hooks/useUploader';
import { useSession } from '../state/session';
import { Avatar, Icon } from './Visual';
import '../avatar.css';

type Selection =
  | { kind: 'still'; file: File; url: string; bitmap: ImageBitmap; width: number; height: number }
  | { kind: 'gif'; file: File; url: string };
type Phase = 'idle' | 'preparing' | 'uploading' | 'processing' | 'applying' | 'confirm-remove' | 'removing';

/** Share of the stage the crop circle takes; the rest shows dimmed context around it. */
const CIRCLE = 0.84;
const NUDGE = 8;

/** What the editor changes: my own photo (default) or a group's (FR-PROF-008). */
export type AvatarTarget =
  | { kind: 'me' }
  | { kind: 'room'; roomId: string; name: string; avatar: UserAvatar | null | undefined }
  | { kind: 'workspace'; name: string; avatar: UserAvatar | null | undefined };

function errorKey(error: unknown): AvatarTextKey {
  if (error instanceof ApiError) {
    if (error.code === 'AVATAR_INVALID') return 'errInvalid';
    if (error.code === 'ROOM_FORBIDDEN' || error.code === 'WS_FORBIDDEN' || error.status === 403) return 'errForbidden';
    if (error.code === 'MEDIA_TOO_LARGE') return 'errServerSize';
    return 'errProcessing';
  }
  if (error instanceof AvatarUploadError) return error.reason === 'processing' ? 'errProcessing' : 'errNetwork';
  if (error instanceof NetworkError || error instanceof TypeError) return 'errNetwork';
  return 'errProcessing';
}

/**
 * FR-PROF-006 / DEC-088 — change or remove my profile photo.
 * FR-PROF-008 / DEC-090 — with `target.kind === 'room'` the same editor
 * changes a group's photo (PATCH /rooms/{id}) instead.
 *
 * Stills are cropped here (drag / pinch / wheel / arrow keys + zoom slider)
 * and re-encoded to a ≤1024px square webp, so the server only ever thumbs a
 * square. GIFs never touch a canvas — that would flatten the animation — so
 * the original bytes are uploaded and the circle centre-crops them on display.
 */
export function AvatarEditor({ onClose, target = { kind: 'me' } }: { onClose: () => void; target?: AvatarTarget }) {
  const { locale } = useChatText();
  const roomTarget = target.kind === 'room' ? target : null;
  const groupLike = target.kind === 'me' ? null : target;
  const text: Record<AvatarTextKey, string> = {
    ...avatarText[locale],
    ...(target.kind === 'room' ? roomAvatarText[locale] : target.kind === 'workspace' ? workspaceAvatarText[locale] : {}),
  };
  const me = useSession(s => s.me);
  const slug = useSession(s => s.currentWorkspace?.workspace.slug ?? '');
  const applyMe = useSession(s => s.applyMe);
  const queryClient = useQueryClient();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [crop, setCrop] = useState<AvatarCrop>({ zoom: 1, x: 0, y: 0 });
  const [stageSize, setStageSize] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<AvatarTextKey | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const busy = phase === 'preparing' || phase === 'uploading' || phase === 'processing' || phase === 'applying' || phase === 'removing';
  const circle = stageSize * CIRCLE;

  const chooseRef = useRef<HTMLButtonElement>(null);
  // showModal() runs the dialog focusing steps (first focusable = the close
  // button); the primary action is choosing a photo, so move focus there.
  useEffect(() => { dialogRef.current?.showModal(); chooseRef.current?.focus(); }, []);

  // Release decoded bitmaps and blob URLs when a selection is replaced or the dialog closes.
  useEffect(() => () => {
    if (selection === null) return;
    URL.revokeObjectURL(selection.url);
    if (selection.kind === 'still') selection.bitmap.close();
  }, [selection]);
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = () => setStageSize(stage.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const image = selection?.kind === 'still' ? { width: selection.width, height: selection.height } : null;
  // Re-clamp when the stage resizes (rotation, sheet → dialog breakpoint).
  useEffect(() => { if (image !== null && circle > 0) setCrop(c => clampCrop(image, circle, c)); }, [circle, image?.width, image?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    abortRef.current?.abort();
    dialogRef.current?.close();
    onClose();
  }, [onClose]);

  const pick = useCallback(async (file: File | null | undefined) => {
    if (!file || busy) return;
    setError(null);
    setPhase('idle');
    const check = checkAvatarFile(file);
    if (!check.ok) {
      setError(check.reason === 'size' ? 'errSize' : check.reason === 'empty' ? 'errEmpty' : 'errType');
      return;
    }
    const url = URL.createObjectURL(file);
    if (check.animated) {
      setSelection({ kind: 'gif', file, url });
      return;
    }
    try {
      // from-image: a phone JPEG's EXIF rotation must survive the crop
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      setSelection({ kind: 'still', file, url, bitmap, width: bitmap.width, height: bitmap.height });
      setCrop({ zoom: 1, x: 0, y: 0 });
      window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
    } catch {
      URL.revokeObjectURL(url);
      setError('errDecode');
    }
  }, [busy]);

  // Paste anywhere while the dialog is open.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'))
        ?? [...(event.clipboardData?.items ?? [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void pick(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [pick]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || image === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setCrop(c => zoomCrop(image, circle, c, c.zoom * Math.exp(-event.deltaY * 0.0015)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [image?.width, image?.height, circle]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (image === null || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: crop.zoom };
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (image === null || previous === undefined) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && pinch.current !== null) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const start = pinch.current;
      setCrop(c => zoomCrop(image, circle, c, start.zoom * (distance / Math.max(1, start.distance))));
      return;
    }
    setCrop(c => panCrop(image, circle, c, event.clientX - previous.x, event.clientY - previous.y));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onStageKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (image === null || busy) return;
    const step = event.shiftKey ? NUDGE * 4 : NUDGE;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      setCrop(c => panCrop(image, circle, c, move[0], move[1]));
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setCrop(c => zoomCrop(image, circle, c, c.zoom + 0.2));
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      setCrop(c => zoomCrop(image, circle, c, c.zoom - 0.2));
    } else if (event.key === '0') {
      event.preventDefault();
      setCrop({ zoom: 1, x: 0, y: 0 });
    }
  };

  const encodeStill = async (still: Extract<Selection, { kind: 'still' }>): Promise<Blob> => {
    const rect = cropSourceRect(still, circle, crop);
    const size = cropOutputSize(rect.size);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas');
    context.imageSmoothingQuality = 'high';
    context.drawImage(still.bitmap, rect.sx, rect.sy, rect.size, rect.size, 0, 0, size, size);
    // Safari may ignore the webp request and hand back PNG: the blob's own
    // type is what gets declared, never the one we asked for.
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (blob === null) throw new Error('encode');
    return blob;
  };

  /** PATCH /me for my photo, PATCH /rooms/{id} for a group's (FR-PROF-008), then refetch every surface. */
  const apply = async (attachmentId: string | null) => {
    if (roomTarget !== null) {
      await endpoints.updateRoom(roomTarget.roomId, slug, { avatar_attachment_id: attachmentId });
      for (const key of ['rooms', 'room']) void queryClient.invalidateQueries({ queryKey: [key] });
      return;
    }
    if (target.kind === 'workspace') {
      await endpoints.updateWorkspace(slug, { avatar_attachment_id: attachmentId });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      return;
    }
    const { user } = await endpoints.updateMe({ avatar_attachment_id: attachmentId });
    applyMe(user);
    invalidatePeople(queryClient);
  };

  const save = async () => {
    if (selection === null || busy || slug === '') return;
    setError(null);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setPhase('preparing');
      const blob = selection.kind === 'gif' ? selection.file : await encodeStill(selection);
      const extension = blob.type.split('/')[1] ?? 'webp';
      const filename = selection.kind === 'gif' ? selection.file.name : `avatar.${extension}`;
      setPhase('uploading');
      const id = await uploadAvatar(slug, blob, filename, {
        signal: controller.signal,
        onProgress: fraction => { setProgress(fraction); if (fraction >= 1) setPhase('processing'); },
      });
      setPhase('applying');
      await apply(id);
      close();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPhase('idle');
      setError(errorKey(caught));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const remove = async () => {
    setError(null);
    setPhase('removing');
    try {
      await apply(null);
      close();
    } catch (caught) {
      setPhase('confirm-remove');
      setError(caught instanceof ApiError && caught.status === 403 ? 'errForbidden' : 'errRemove');
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    void pick(event.dataTransfer.files[0]);
  };

  const status: string | null = phase === 'preparing' ? text.preparing
    : phase === 'uploading' ? text.uploading.replace('{p}', String(Math.round(progress * 100)))
    : phase === 'processing' ? text.processing
    : phase === 'applying' ? text.applying
    : phase === 'removing' ? text.removing
    : null;
  const ringProgress = phase === 'uploading' ? progress : phase === 'processing' || phase === 'applying' ? 1 : 0;
  const currentName = groupLike !== null ? groupLike.name : me?.display_name ?? '';
  const currentAvatar = groupLike !== null ? groupLike.avatar : me?.avatar;
  const hasPhoto = currentAvatar != null;
  const scale = image !== null && circle > 0 ? cropCoverScale(image, circle) * crop.zoom : 0;
  const ringRadius = circle / 2 + 5;
  const ringLength = 2 * Math.PI * ringRadius;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`bc-avatar-editor ${dragOver ? 'is-drag-over' : ''}`}
      data-testid="avatar-editor"
      data-target={target.kind}
      aria-labelledby={titleId}
      aria-busy={busy}
      lang={locale}
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => {
        // Backdrop click dismisses only while nothing would be lost.
        if (event.target !== event.currentTarget || selection !== null || busy) return;
        const r = event.currentTarget.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
      }}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDragLeave={event => { if (event.currentTarget === event.target) setDragOver(false); }}
      onDrop={onDrop}
    >
      <header className="bc-ae-header">
        <div>
          <h2 id={titleId}>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button type="button" className="bc-ae-icon-button" aria-label={text.close} onClick={close}><Icon name="close" size={18} /></button>
      </header>

      <div
        ref={stageRef}
        className={`bc-ae-stage is-${selection?.kind ?? 'current'}`}
        data-testid="avatar-stage"
        style={{ '--ae-circle': `${circle}px` } as CSSProperties}
        {...(selection?.kind === 'still' ? {
          tabIndex: 0,
          role: 'group',
          'aria-label': text.stage,
          'aria-roledescription': text.dragHint,
          onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
          onKeyDown: onStageKey,
        } : {})}
      >
        {selection?.kind === 'still' && scale > 0 && (
          <img
            className="bc-ae-crop-image"
            data-testid="avatar-crop-image"
            src={selection.url}
            alt=""
            draggable={false}
            style={{ width: selection.width * scale, height: selection.height * scale, transform: `translate(-50%, -50%) translate(${crop.x}px, ${crop.y}px)` }}
          />
        )}
        <div className="bc-ae-circle" data-testid="avatar-circle">
          {selection?.kind === 'gif' && <img className="bc-ae-gif" data-testid="avatar-gif-preview" src={selection.url} alt="" draggable={false} />}
          {selection === null && <Avatar name={currentName} avatar={currentAvatar} large className="bc-ae-current" label={hasPhoto ? text.current : text.noPhoto} />}
        </div>
        {ringProgress > 0 && (
          <svg className="bc-ae-ring" viewBox={`0 0 ${stageSize} ${stageSize}`} aria-hidden="true">
            <circle cx={stageSize / 2} cy={stageSize / 2} r={ringRadius} strokeDasharray={ringLength} strokeDashoffset={ringLength * (1 - ringProgress)} className={phase === 'uploading' ? '' : 'is-pulsing'} />
          </svg>
        )}
      </div>

      <div className="bc-ae-panel">
        {selection === null && (
          <div className={`bc-ae-drop ${dragOver ? 'is-active' : ''}`} data-testid="avatar-drop-zone">
            <span className="bc-ae-drop-icon"><Icon name="image" size={22} /></span>
            <div className="bc-ae-drop-copy">
              <strong>{text.dropTitle}</strong>
              <span>{text.formats}</span>
            </div>
            <button type="button" className="bc-ae-button is-secondary" onClick={() => inputRef.current?.click()} ref={chooseRef} data-testid="avatar-choose">{text.choose}</button>
          </div>
        )}
        {selection === null && <p className="bc-ae-note">{hasPhoto ? text.pasteHint : text.noPhoto}</p>}

        {selection?.kind === 'still' && <p className="bc-ae-caption" aria-hidden="true">{text.dragHint}</p>}
        {selection?.kind === 'still' && (
          <div className="bc-ae-zoom">
            <button type="button" className="bc-ae-icon-button" aria-label={text.zoomOut} disabled={busy || crop.zoom <= AVATAR_MIN_ZOOM} onClick={() => image && setCrop(c => zoomCrop(image, circle, c, c.zoom - 0.25))}><Icon name="minus" size={18} /></button>
            <input
              type="range"
              aria-label={text.zoom}
              data-testid="avatar-zoom"
              min={AVATAR_MIN_ZOOM}
              max={AVATAR_MAX_ZOOM}
              step={0.01}
              value={crop.zoom}
              disabled={busy}
              style={{ '--ae-fill': `${((crop.zoom - AVATAR_MIN_ZOOM) / (AVATAR_MAX_ZOOM - AVATAR_MIN_ZOOM)) * 100}%` } as CSSProperties}
              onChange={event => image && setCrop(c => zoomCrop(image, circle, c, Number(event.target.value)))}
            />
            <button type="button" className="bc-ae-icon-button" aria-label={text.zoomIn} disabled={busy || crop.zoom >= AVATAR_MAX_ZOOM} onClick={() => image && setCrop(c => zoomCrop(image, circle, c, c.zoom + 0.25))}><Icon name="plus" size={18} /></button>
          </div>
        )}
        {selection?.kind === 'gif' && (
          <p className="bc-ae-note is-gif"><span className="bc-ae-badge">{text.gifBadge}</span><span data-testid="avatar-gif-hint">{text.gifHint}</span></p>
        )}
        {selection !== null && (
          <button type="button" className="bc-ae-link" disabled={busy} onClick={() => inputRef.current?.click()} data-testid="avatar-choose-other">{text.chooseOther}</button>
        )}

        <input
          ref={inputRef}
          type="file"
          hidden
          accept={AVATAR_MIME_TYPES.join(',')}
          data-testid="avatar-file-input"
          onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }}
        />

        <p className="bc-ae-status" role="status" aria-live="polite" data-testid="avatar-status">{status}</p>
        {error !== null && <p className="bc-ae-error" role="alert" data-testid="avatar-error">{text[error]}</p>}
      </div>

      {(phase === 'confirm-remove' || phase === 'removing') ? (
        <div className="bc-ae-confirm" role="alertdialog" aria-labelledby={`${titleId}-remove`} aria-describedby={`${titleId}-remove-body`} data-testid="avatar-remove-confirm">
          <p><strong id={`${titleId}-remove`}>{text.removeTitle}</strong> <span id={`${titleId}-remove-body`}>{text.removeBody}</span></p>
          <div className="bc-ae-actions">
            <button type="button" className="bc-ae-button is-secondary" disabled={busy} onClick={() => { setError(null); setPhase('idle'); }} autoFocus>{text.keep}</button>
            <button type="button" className="bc-ae-button is-danger" disabled={busy} onClick={() => void remove()} data-testid="avatar-remove-confirm-button">{phase === 'removing' ? text.removing : text.confirmRemove}</button>
          </div>
        </div>
      ) : (
        <footer className="bc-ae-actions">
          {hasPhoto && selection === null && (
            <button type="button" className="bc-ae-button is-quiet-danger" disabled={busy} onClick={() => { setError(null); setPhase('confirm-remove'); }} data-testid="avatar-remove">{text.remove}</button>
          )}
          <button type="button" className="bc-ae-button is-secondary" onClick={close}>{text.cancel}</button>
          <button type="button" className="bc-ae-button is-primary" disabled={selection === null || busy} onClick={() => void save()} data-testid="avatar-save">{busy ? text.saving : text.save}</button>
        </footer>
      )}
    </dialog>,
    document.body,
  );
}
