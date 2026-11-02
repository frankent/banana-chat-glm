import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '@banana-chat/shared';
import type { Locale } from '@banana-chat/shared';
import {
  GROUP_PASSWORD_MAX,
  generateGroupPassword,
  groupPasswordStrength,
} from '@banana-chat/chat-core';
import { Icon } from './Visual';

/** FR-PCHAT-043 — native modal/drawer: focus trap, Esc, backdrop and focus return come from the platform. */
export function PcDialog({
  open,
  onClose,
  title,
  children,
  footer,
  drawer = false,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  drawer?: boolean;
  locale: Locale;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`pc-dialog bc-pchat-surface${drawer ? ' drawer' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="pc-dialog-head">
            <h2 id={titleId} className="pc-h2">
              {title}
            </h2>
            <button type="button" className="pc-button pc-icon-button" aria-label={t('pchat.action.close', locale)} onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="pc-dialog-body">{children}</div>
          {footer && <div className="pc-dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** FR-PCHAT-043 — password input with show/hide, optional generator and length-only guidance. */
export function PublicChatPasswordField({
  value,
  onChange,
  locale,
  label,
  generate = false,
  meter = false,
  autoComplete = 'new-password',
  error,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  locale: Locale;
  label: string;
  generate?: boolean;
  meter?: boolean;
  autoComplete?: string;
  error?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const [announce, setAnnounce] = useState('');
  const strength = groupPasswordStrength(value);
  const level = strength === 'weak' ? 1 : strength === 'good' ? 2 : strength === 'strong' ? 3 : 0;
  return (
    <div className="pc-field-group">
      <label className="pc-label" htmlFor={id}>
        {label}
      </label>
      <div className="pc-input-row">
        <input
          id={id}
          ref={inputRef}
          className="pc-field"
          type={shown ? 'text' : 'password'}
          value={value}
          maxLength={GROUP_PASSWORD_MAX}
          autoComplete={autoComplete}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pc-button pc-icon-button"
          aria-label={t(shown ? 'pchat.password.hide' : 'pchat.password.show', locale)}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={18} />
        </button>
        {generate && (
          <button
            type="button"
            className="pc-button"
            onClick={() => {
              onChange(generateGroupPassword());
              setShown(true);
              setAnnounce(t('pchat.password.generated', locale));
            }}
          >
            {t('pchat.password.generate', locale)}
          </button>
        )}
      </div>
      <p id={`${id}-help`} className="pc-help">
        {t('pchat.password.hint', locale)}
      </p>
      {meter && level > 0 && (
        <div className="pc-meter" data-level={level} aria-hidden="true">
          <i />
          <i />
          <i />
          <span>{t(`pchat.password.${strength}`, locale)}</span>
        </div>
      )}
      {error && (
        <p className="pc-field-error" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
        {announce}
      </span>
    </div>
  );
}

/** Copy text; resolves false when the clipboard is unavailable so callers can show the manual-copy hint. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** FR-PCHAT-043 — pre-join sheet. Camera stays off unless opted in (FR-CALL-007). */
export function PublicChatPreJoin({
  open,
  room,
  name,
  locale,
  busy,
  error,
  onCancel,
  onJoin,
}: {
  open: boolean;
  room: string;
  name: string;
  locale: Locale;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onJoin: (media: { microphoneEnabled: boolean; cameraEnabled: boolean }) => void;
}) {
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <PcDialog
      open={open}
      onClose={onCancel}
      locale={locale}
      title={t('pchat.meeting.prejoinTitle', locale).replace('{room}', room)}
      footer={
        <>
          <button type="button" className="pc-button" onClick={onCancel}>
            {t('pchat.action.cancel', locale)}
          </button>
          <button
            type="button"
            className="pc-button primary lg"
            disabled={busy}
            onClick={() => onJoin({ microphoneEnabled: mic, cameraEnabled: cam })}
          >
            <Icon name="video" size={18} />
            {busy ? t('pchat.meeting.connecting', locale) : t('pchat.meeting.join', locale)}
          </button>
        </>
      }
    >
      <div className="pc-prejoin-preview" aria-hidden="true">
        <div>
          <div className="pc-avatar" style={{ margin: '0 auto' }}>
            {initial}
          </div>
          <p style={{ marginTop: 8 }}>{cam ? t('pchat.meeting.cameraOn', locale) : t('pchat.meeting.cameraOff', locale)}</p>
        </div>
      </div>
      <p className="pc-help">{t('pchat.meeting.joinAs', locale).replace('{name}', name)}</p>
      <label className="pc-switch">
        <input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} />
        <span>
          <strong>{t('pchat.meeting.microphone', locale)}</strong>
          <span className="pc-help">{t(mic ? 'pchat.meeting.micOn' : 'pchat.meeting.micOff', locale)}</span>
        </span>
      </label>
      <label className="pc-switch">
        <input type="checkbox" checked={cam} onChange={(e) => setCam(e.target.checked)} />
        <span>
          <strong>{t('pchat.meeting.camera', locale)}</strong>
          <span className="pc-help">{t(cam ? 'pchat.meeting.cameraOn' : 'pchat.meeting.cameraOff', locale)}</span>
        </span>
      </label>
      {error && (
        <p className="pc-alert" role="alert">
          {error}
        </p>
      )}
    </PcDialog>
  );
}
