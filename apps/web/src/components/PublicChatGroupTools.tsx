import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@banana-chat/shared';
import type { Locale } from '@banana-chat/shared';
import { isValidGroupPassword, isValidGroupTitle, parseGroupExpiryDays, GROUP_TITLE_MAX } from '@banana-chat/chat-core';
import { pchat, pchatErrorMessage } from '../lib/public-chat';
import { PublicChatMeeting } from './PublicChatMeeting';
import { PcDialog, PublicChatPasswordField, copyText } from './PublicChatUi';
import { Icon } from './Visual';

// Member pages are English-only (they use en()).
const L: Locale = 'en';
const tr = (key: string) => t(key, L);
const PRESETS = [1, 7, 30, 90];

interface Created {
  id: string;
  url: string;
  password: string;
  expiresAt: Date;
  video: boolean;
}

/** FR-PCHAT-040/043 — create a password-protected group room in a modal; the success card shows link + password once. */
export function NewGroupRoom({ slug, onCreated }: { slug: string; onCreated: (roomId: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [preset, setPreset] = useState<number | 'custom'>(30);
  const [custom, setCustom] = useState('30');
  const [withMeeting, setWithMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [videoFailed, setVideoFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [notice, setNotice] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);

  const days = preset === 'custom' ? parseGroupExpiryDays(custom) : preset;
  const titleOk = isValidGroupTitle(title);
  const passwordOk = isValidGroupPassword(password);
  const valid = titleOk && passwordOk && days !== null;

  function reset() {
    setTitle('');
    setPassword('');
    setPreset(30);
    setCustom('30');
    setWithMeeting(false);
    setError('');
    setVideoFailed(false);
    setTouched(false);
    setCreated(null);
    setNotice('');
  }
  function close() {
    if (busy) return;
    const done = created;
    setOpen(false);
    reset();
    if (done) void qc.invalidateQueries({ queryKey: ['public-chat', 'rooms'] });
    trigger.current?.focus();
  }

  async function submit(meeting: boolean) {
    setTouched(true);
    if (!valid || days === null) return;
    setBusy(true);
    setError('');
    try {
      const out = await pchat.createGroup(slug, { title: title.trim(), password, expires_in_days: days, with_meeting: meeting });
      setCreated({ id: out.room.id, url: out.url, password, expiresAt: new Date(Date.now() + days * 86_400_000), video: meeting });
      void qc.invalidateQueries({ queryKey: ['public-chat', 'rooms'] });
    } catch (e) {
      const msg = pchatErrorMessage(e, L);
      if (meeting) {
        setVideoFailed(true);
        setError(tr('pchat.group.videoUnavailable'));
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, ok: string) {
    setNotice((await copyText(text)) ? ok : tr('pchat.group.copyFailed'));
  }

  const body = created ? (
    <>
      <div className="pc-note" role="status">
        <strong>{tr('pchat.group.created')}</strong>
        <br />
        {tr('pchat.group.savePassword')} {tr('pchat.group.shareSeparately')}
      </div>
      <div className="pc-field-group">
        <label className="pc-label" htmlFor="pc-created-link">{tr('pchat.group.link')}</label>
        <div className="pc-input-row">
          <input id="pc-created-link" className="pc-field" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="pc-button" onClick={() => void copy(created.url, tr('pchat.group.copied'))}>
            {tr('pchat.group.copyLink')}
          </button>
        </div>
      </div>
      <div className="pc-field-group">
        <label className="pc-label" htmlFor="pc-created-pw">{tr('pchat.group.password')}</label>
        <div className="pc-input-row">
          <input id="pc-created-pw" className="pc-field" readOnly value={created.password} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="pc-button" onClick={() => void copy(created.password, tr('pchat.group.passwordCopied'))}>
            {tr('pchat.group.copyPassword')}
          </button>
        </div>
      </div>
      <p className="pc-help">
        {tr('pchat.group.roomExpires').replace('{date}', created.expiresAt.toLocaleDateString())}
        {created.video ? ` · ${tr('pchat.group.videoEnabled')}` : ''}
      </p>
      <p role="status" className="pc-help">{notice}</p>
    </>
  ) : (
    <form
      id="pc-new-group"
      className="pc-form"
      style={{ padding: 0 }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(withMeeting);
      }}
    >
      <p className="pc-help">{tr('pchat.group.description')}</p>
      <div className="pc-field-group">
        <label className="pc-label" htmlFor="pc-new-title">{tr('pchat.group.title')}</label>
        <input
          id="pc-new-title"
          className="pc-field"
          autoFocus
          maxLength={GROUP_TITLE_MAX}
          value={title}
          aria-invalid={touched && !titleOk ? true : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
        {touched && !titleOk && <p className="pc-field-error" role="alert">{tr('pchat.group.nameInvalid')}</p>}
      </div>
      <PublicChatPasswordField
        value={password}
        onChange={setPassword}
        locale={L}
        label={tr('pchat.group.password')}
        generate
        meter
        error={touched && !passwordOk ? tr('pchat.password.invalid') : undefined}
      />
      <fieldset className="pc-field-group" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="pc-label">{tr('pchat.group.expiry')}</legend>
        <div className="pc-row">
          {PRESETS.map((d) => (
            <button key={d} type="button" className="pc-button pc-chip" aria-pressed={preset === d} onClick={() => setPreset(d)}>
              {d === 1 ? tr('pchat.group.oneDay') : tr('pchat.group.days').replace('{count}', String(d))}
            </button>
          ))}
          <button type="button" className="pc-button pc-chip" aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>
            {tr('pchat.group.customExpiry')}
          </button>
        </div>
        {preset === 'custom' && (
          <>
            <label className="pc-label" htmlFor="pc-new-days">{tr('pchat.group.customDays')}</label>
            <input
              id="pc-new-days"
              className="pc-field"
              inputMode="numeric"
              value={custom}
              aria-invalid={touched && days === null ? true : undefined}
              onChange={(e) => setCustom(e.target.value)}
            />
          </>
        )}
        {touched && days === null && <p className="pc-field-error" role="alert">{tr('pchat.group.expiryInvalid')}</p>}
      </fieldset>
      <label className="pc-switch">
        <input type="checkbox" checked={withMeeting} onChange={(e) => setWithMeeting(e.target.checked)} />
        <span>
          <strong>{tr('pchat.group.withMeeting')}</strong>
          <span className="pc-help">{tr('pchat.group.videoHint')}</span>
        </span>
      </label>
      {error && <p className="pc-alert" role="alert">{error}</p>}
    </form>
  );

  return (
    <div className="bc-pchat-surface" style={{ display: 'contents' }}>
      <button ref={trigger} type="button" className="pc-button primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} />
        {tr('pchat.group.new')}
      </button>
      <PcDialog
        open={open}
        onClose={close}
        locale={L}
        title={created ? tr('pchat.group.created') : tr('pchat.group.new')}
        footer={
          created ? (
            <button type="button" className="pc-button primary lg" onClick={() => onCreated(created.id)}>
              {tr('pchat.group.open')}
            </button>
          ) : (
            <>
              <button type="button" className="pc-button" onClick={close} disabled={busy}>{tr('pchat.action.cancel')}</button>
              {videoFailed && (
                <button type="button" className="pc-button" disabled={busy} onClick={() => void submit(false)}>
                  {tr('pchat.group.withoutVideo')}
                </button>
              )}
              <button type="submit" form="pc-new-group" className="pc-button primary lg" disabled={busy}>
                {busy ? tr('pchat.group.creating') : tr('pchat.group.create')}
              </button>
            </>
          )
        }
      >
        {body}
      </PcDialog>
    </div>
  );
}

/** FR-PCHAT-040/041/042/043 — header actions for a group room: join video + a room-tools drawer (share, access). */
export function GroupRoomTools({
  slug,
  roomId,
  title,
  hasMeeting,
  host,
  onVideoChange,
  memberName = 'Host',
}: {
  slug: string;
  roomId: string;
  title: string;
  hasMeeting: boolean;
  host?: HTMLElement | null;
  onVideoChange?: (active: boolean) => void;
  memberName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    setPassword('');
    setTouched(false);
    setNotice('');
    setError('');
    trigger.current?.focus();
  }

  async function copyLink() {
    setError('');
    try {
      const out = await pchat.groupLink(slug, roomId);
      setNotice((await copyText(out.url)) ? tr('pchat.group.copied') : tr('pchat.group.copyFailed'));
    } catch (e) {
      setError(pchatErrorMessage(e, L));
    }
  }

  async function rotate() {
    setTouched(true);
    if (!isValidGroupPassword(password)) return;
    setBusy(true);
    setError('');
    try {
      await pchat.changePassword(slug, roomId, password);
      setNotice(tr('pchat.group.passwordChanged'));
      setPassword('');
      setTouched(false);
    } catch (e) {
      setError(pchatErrorMessage(e, L));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bc-pchat-group-tools bc-pchat-surface pc-row">
      {hasMeeting && (
        <PublicChatMeeting
          title={title}
          locale={L}
          name={memberName}
          host={host}
          onActiveChange={onVideoChange}
          join={(resume) => pchat.memberMeetingJoin(slug, roomId, resume)}
          leave={(token) => pchat.memberMeetingLeave(slug, roomId, token)}
        />
      )}
      <button ref={trigger} type="button" className="pc-button" onClick={() => setOpen(true)}>
        <Icon name="lock" size={18} />
        {tr('pchat.group.tools')}
      </button>
      <PcDialog open={open} onClose={close} drawer locale={L} title={tr('pchat.group.tools')}>
        <section className="pc-field-group">
          <h3 className="pc-h3">{tr('pchat.group.shareRoom')}</h3>
          <button type="button" className="pc-button" onClick={() => void copyLink()}>
            {tr('pchat.group.copyLink')}
          </button>
        </section>
        <section className="pc-field-group">
          <h3 className="pc-h3">{tr('pchat.group.access')}</h3>
          <p className="pc-help">{tr('pchat.group.currentPasswordHidden')}</p>
          <PublicChatPasswordField
            value={password}
            onChange={setPassword}
            locale={L}
            label={tr('pchat.group.newPassword')}
            generate
            meter
            error={touched && !isValidGroupPassword(password) ? tr('pchat.password.invalid') : undefined}
          />
          <p className="pc-note">{tr('pchat.group.passwordImpact')}</p>
          <button type="button" className="pc-button primary" disabled={busy} onClick={() => void rotate()}>
            {tr('pchat.group.changePassword')}
          </button>
          <p className="pc-help">{tr('pchat.group.securityNote')}</p>
        </section>
        <p role="status" className="pc-help">{notice}</p>
        {error && <p className="pc-alert" role="alert">{error}</p>}
      </PcDialog>
    </div>
  );
}
