import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@banana-chat/api-client';
import { endpoints } from '../lib/api';
import { privacyText } from '../lib/privacy-text';
import { Banana, Icon } from './Visual';
import '../privacy.css';

type Props = { onUnlock: () => void; onLogout: () => void; locale: 'th' | 'en' };

/** FR-NOTI-009: opaque, accessible cover; the parent retains chat/call state. */
export function PrivacyLockScreen({ onUnlock, onLogout, locale }: Props) {
  const text = privacyText[locale];
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<keyof typeof privacyText.en | null>(null);

  useEffect(() => {
    alive.current = true;
    const field = input.current;
    field?.focus();
    return () => {
      alive.current = false;
      if (field) field.value = '';
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || !input.current?.value) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    // DEC-087: password never enters app state, storage, logs, or a retained closure.
    try {
      const verification = endpoints.verifyPassword(input.current.value);
      input.current.value = '';
      setVisible(false);
      await verification;
      if (alive.current) onUnlock();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof ApiError
        ? cause.status === 429 ? 'limited'
          : cause.code === 'INVALID_PASSWORD' ? 'invalid'
            : cause.status === 401 ? 'expired' : 'failed'
        : 'network');
    } finally {
      if (input.current) input.current.value = '';
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        // Readonly preserves focus and allows focus restoration before React commits.
        input.current?.focus();
      }
    }
  };

  return (
    <div className="bc-privacy-lock" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-hint`} lang={locale} data-testid="privacy-lock-screen">
      <div className="bc-privacy-card">
        <div className="bc-privacy-brand"><span><Banana size={32} /></span>Banana Chat</div>
        <div className="bc-privacy-emblem" aria-hidden="true"><Icon name="lock" size={30} /></div>
        <p className="bc-privacy-eyebrow">{text.title}</p>
        <h1 id={`${id}-heading`}>{text.heading}</h1>
        <p className="bc-privacy-hint" id={`${id}-hint`}>{text.hint}</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor={`${id}-password`}>{text.password}</label>
          <div className="bc-privacy-field">
            <input ref={input} id={`${id}-password`} type={visible ? 'text' : 'password'} autoComplete="current-password" autoFocus required maxLength={256} readOnly={busy} aria-invalid={error === 'invalid'} aria-describedby={error ? `${id}-error` : undefined} data-testid="privacy-password" />
            <button type="button" className="bc-privacy-eye" aria-label={visible ? text.hide : text.show} aria-pressed={visible} disabled={busy} onClick={() => setVisible(!visible)}><Icon name={visible ? 'eyeOff' : 'eye'} size={20} /></button>
          </div>
          {error && <p className="bc-privacy-error" role="alert" id={`${id}-error`}>{text[error]}</p>}
          <button className="bc-privacy-submit" type="submit" disabled={busy}>{busy ? text.unlocking : text.unlock}<Icon name="arrow" size={18} /></button>
        </form>
        <button type="button" className="bc-privacy-logout" onClick={() => { alive.current = false; if (input.current) input.current.value = ''; onLogout(); }}>{text.logout}</button>
        <p className="bc-privacy-footnote">{text.forgot}</p>
      </div>
    </div>
  );
}
