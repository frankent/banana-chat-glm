/**
 * FR-AUTH-008 / FR-WS-006 / DEC-081 — public, unauthenticated. Route
 * `/join/:token`, declared in App.tsx as a SIBLING of `/meet/:code` and
 * `/support/:code`, outside both <EchoProvider> and <CallProvider> — a
 * brand-new person has no account yet, so nothing here should be able to
 * reach realtime/call context before one exists.
 */
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@banana-chat/api-client';
import { t } from '@banana-chat/shared';
import type { Locale } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';
import { Avatar, Icon } from '../components/Visual';
import { Logo } from '../components/Logo';

const TERMINAL_ERROR_KEYS: Record<string, string> = {
  INVITE_NOT_FOUND: 'join.errorNotFound',
  INVITE_EXPIRED: 'join.errorExpired',
  INVITE_REVOKED: 'join.errorRevoked',
  INVITE_ALREADY_USED: 'join.errorAlreadyUsed',
};

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

// There is no signed-in user yet to read a locale preference from, so this
// page (and the account it creates — see redeemInvite's `locale` arg) goes
// by the browser's own language instead of always defaulting to English.
function detectLocale(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('th') ? 'th' : 'en';
}

type FieldName = 'displayName' | 'username' | 'password';

export function JoinInvitePage() {
  const { token = '' } = useParams();
  return <JoinInvite key={token} token={token} />;
}

function JoinInvite({ token }: { token: string }) {
  const [locale] = useState(detectLocale);
  const text = (key: string) => t(key, locale);
  const { status: sessionStatus, logout, installSession } = useSession();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['join-preview', token],
    queryFn: () => endpoints.joinInvitePreview(token),
    enabled: sessionStatus !== 'loading',
    retry: false,
  });

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: FieldName | null; message: string } | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  const fieldRefs = { displayName: useRef<HTMLInputElement>(null), username: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };

  const fail = (field: FieldName | null, message: string) => {
    setFieldError({ field, message });
    if (field !== null) fieldRefs[field].current?.focus();
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFieldError(null);

    const trimmedName = displayName.trim();
    const trimmedUsername = username.trim();
    if (trimmedName === '') return fail('displayName', text('join.required'));
    if (trimmedUsername === '') return fail('username', text('join.required'));
    if (!USERNAME_PATTERN.test(trimmedUsername)) return fail('username', text('join.errorUsernameInvalid'));
    if (password === '') return fail('password', text('join.required'));

    setSubmitting(true);
    try {
      const result = await endpoints.redeemInvite(token, trimmedUsername, password, trimmedName, {
        platform: 'web',
        name: `Browser (${navigator.userAgent.slice(0, 40)})`,
      }, locale);
      installSession(result);
      navigate('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code in TERMINAL_ERROR_KEYS) {
        setTerminalError(TERMINAL_ERROR_KEYS[e.code]);
      } else if (e instanceof ApiError && e.code === 'AUTH_USERNAME_TAKEN') {
        fail('username', text('join.errorUsernameTaken'));
      } else if (e instanceof ApiError && e.code === 'AUTH_PASSWORD_WEAK') {
        fail('password', text('join.errorPasswordWeak'));
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && e.details?.fields?.username !== undefined) {
        fail('username', text('join.errorUsernameInvalid'));
      } else {
        fail(null, text('join.errorGeneric'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const previewErrorKey = preview.isError
    ? (preview.error instanceof ApiError && preview.error.code in TERMINAL_ERROR_KEYS
      ? TERMINAL_ERROR_KEYS[preview.error.code]
      : 'join.checkFailed')
    : null;

  return (
    <main className="bc-join-page">
      <header className="bc-join-header">
        <span className="bc-join-brand"><Logo size={28} /> {text('join.brand')}</span>
      </header>
      <section className="bc-join-content">
        <p className="bc-join-eyebrow">{text('join.invitation')}</p>

        {preview.isPending && (
          <div className="bc-join-workspace-tile is-loading" aria-live="polite">{text('join.checkingInvite')}</div>
        )}

        {previewErrorKey !== null && (
          <div className="bc-join-error-state" role="alert">
            <p>{text(previewErrorKey)}</p>
            {previewErrorKey === 'join.checkFailed' && (
              <button type="button" className="bc-join-secondary" onClick={() => void preview.refetch()}>{text('join.retry')}</button>
            )}
          </div>
        )}

        {terminalError !== null && (
          <div className="bc-join-error-state" role="alert">
            <p>{text(terminalError)}</p>
          </div>
        )}

        {preview.data !== undefined && terminalError === null && (
          <>
            <div className="bc-join-workspace-tile">
              <Avatar name={preview.data.workspace.name} />
              <span>{preview.data.workspace.name}</span>
            </div>

            {sessionStatus === 'authenticated' ? (
              <div className="bc-join-signed-in">
                <p>{text('join.alreadySignedIn')}</p>
                <button type="button" className="bc-join-secondary" onClick={() => void logout()}>{text('join.signOutToContinue')}</button>
              </div>
            ) : (
              <>
                <h1>{text('join.createAccount')}</h1>
                <p className="bc-join-explanation">{text('join.memberExplanation')}</p>

                <form onSubmit={event => void onSubmit(event)} className="bc-join-form" noValidate>
                  {fieldError !== null && fieldError.field === null && (
                    <p className="bc-join-form-error" role="alert">{fieldError.message}</p>
                  )}

                  <label className="bc-join-field">
                    <span>{text('join.displayName')}</span>
                    <input
                      ref={fieldRefs.displayName}
                      value={displayName}
                      onChange={e => setDisplayName(e.target.value)}
                      maxLength={80}
                      autoFocus
                      className="bc-join-input"
                      aria-invalid={fieldError?.field === 'displayName'}
                      aria-describedby="join-display-name-hint"
                    />
                    <small id="join-display-name-hint">{fieldError?.field === 'displayName' ? <span className="bc-join-field-error" role="alert">{fieldError.message}</span> : text('join.displayNameHint')}</small>
                  </label>

                  <label className="bc-join-field">
                    <span>{text('join.username')}</span>
                    <input
                      ref={fieldRefs.username}
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      minLength={3}
                      maxLength={32}
                      pattern="[a-z0-9._-]{3,32}"
                      autoComplete="username"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="bc-join-input"
                      aria-invalid={fieldError?.field === 'username'}
                      aria-describedby="join-username-hint"
                    />
                    <small id="join-username-hint">{fieldError?.field === 'username' ? <span className="bc-join-field-error" role="alert">{fieldError.message}</span> : `${text('join.usernameHint')} ${text('join.usernamePattern')}`}</small>
                  </label>

                  <label className="bc-join-field">
                    <span>{text('join.password')}</span>
                    <div className="bc-join-password-row">
                      <input
                        ref={fieldRefs.password}
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        maxLength={256}
                        autoComplete="new-password"
                        className="bc-join-input"
                        aria-invalid={fieldError?.field === 'password'}
                        aria-describedby="join-password-hint"
                      />
                      <button type="button" className="bc-join-password-toggle" onClick={() => setShowPassword(show => !show)} aria-label={showPassword ? text('join.hidePassword') : text('join.showPassword')}>
                        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                      </button>
                    </div>
                    <small id="join-password-hint">{fieldError?.field === 'password' ? <span className="bc-join-field-error" role="alert">{fieldError.message}</span> : text('join.passwordHint')}</small>
                  </label>

                  <button type="submit" disabled={submitting} className="bc-join-submit">
                    {submitting ? text('join.submitting') : text('join.submit')}
                  </button>
                </form>

                <p className="bc-join-existing"><Link to="/login">{text('join.existingAccount')}</Link><br /><small>{text('join.existingAccountHint')}</small></p>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
