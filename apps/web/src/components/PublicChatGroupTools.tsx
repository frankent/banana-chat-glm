import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@banana-chat/shared';
import type { Locale } from '@banana-chat/shared';
import { pchat, pchatErrorMessage } from '../lib/public-chat';
import { PublicChatMeeting } from './PublicChatMeeting';

const L: Locale = 'en';
const tr = (key: string) => t(key, L);

/** FR-PCHAT-040 — create a password-protected group room (optionally with a video meeting). */
export function NewGroupRoom({ slug, onCreated }: { slug: string; onCreated: (roomId: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState('30');
  const [withMeeting, setWithMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const out = await pchat.createGroup(slug, {
        title: title.trim(),
        password,
        expires_in_days: Number(days) || undefined,
        with_meeting: withMeeting,
      });
      setCreated({ id: out.room.id, url: out.url });
      void qc.invalidateQueries({ queryKey: ['public-chat', 'rooms'] });
    } catch (e) {
      setError(pchatErrorMessage(e, L));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="bc-primary" onClick={() => setOpen(true)}>
        {tr('pchat.group.new')}
      </button>
    );
  }

  if (created !== null) {
    return (
      <div role="status">
        <p>{tr('pchat.group.created')}</p>
        <input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(created.url).then(() => setCopied(true)).catch(() => {});
          }}
        >
          {copied ? tr('pchat.group.copied') : tr('pchat.group.copyLink')}
        </button>
        <button type="button" className="bc-primary" onClick={() => onCreated(created.id)}>
          Open
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        {tr('pchat.group.title')}
        <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {tr('pchat.group.password')}
        <input required type="password" minLength={6} maxLength={72} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        {tr('pchat.group.expiry')}
        <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={withMeeting} onChange={(e) => setWithMeeting(e.target.checked)} /> {tr('pchat.group.withMeeting')}
      </label>
      <button className="bc-primary" disabled={busy || title.trim() === '' || password.length < 6}>
        {tr('pchat.group.create')}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** FR-PCHAT-040/041/042 — copy link, rotate password, join the meeting; shown on a group room's header. */
export function GroupRoomTools({ slug, roomId, title, hasMeeting }: { slug: string; roomId: string; title: string; hasMeeting: boolean }) {
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  return (
    <div className="bc-pchat-group-tools">
      <button
        type="button"
        onClick={() => {
          setError('');
          void pchat
            .groupLink(slug, roomId)
            .then((out) => navigator.clipboard.writeText(out.url))
            .then(() => setNotice(tr('pchat.group.copied')))
            .catch((e: unknown) => setError(pchatErrorMessage(e, L)));
        }}
      >
        {tr('pchat.group.copyLink')}
      </button>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            void pchat
              .changePassword(slug, roomId, password)
              .then(() => {
                setNotice(tr('pchat.group.passwordChanged'));
                setPassword('');
                setEditing(false);
              })
              .catch((err: unknown) => setError(pchatErrorMessage(err, L)));
          }}
        >
          <input type="password" required minLength={6} maxLength={72} autoComplete="new-password" aria-label={tr('pchat.group.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="bc-primary" disabled={password.length < 6}>
            {tr('pchat.group.changePassword')}
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          {tr('pchat.group.changePassword')}
        </button>
      )}
      {hasMeeting && (
        <PublicChatMeeting
          title={title}
          locale={L}
          join={(resume) => pchat.memberMeetingJoin(slug, roomId, resume)}
          leave={(token) => pchat.memberMeetingLeave(slug, roomId, token)}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
