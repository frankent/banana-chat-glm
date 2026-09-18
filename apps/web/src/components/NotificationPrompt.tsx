import { useEffect, useState } from 'react';
import { canAskForNotifications, enableNotifications } from '../lib/enable-notifications';
import { currentWebPushStatus } from '../lib/web-push';
import { Icon } from './Visual';

/**
 * FR-NOTI-003 — the soft ask.
 *
 * Firing requestPermission() on page load does not work and is not allowed to:
 * Safari ignores it outside a user gesture, and Chrome demotes sites that do it
 * into a muted indicator the user never notices. So this asks in our own UI and
 * calls the native prompt only from the press on "Turn on" -- which is also what
 * TC-WEB-030 requires.
 *
 * It exists because the opt-in was previously buried in a panel nobody opened:
 * every device row in staging and production had a null push_token, so no push
 * had anywhere to go.
 */

const SNOOZE_KEY = 'banana-chat:push-prompt-snoozed-until';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const MONTH = 30 * 24 * 60 * 60 * 1000;
/** Long enough for the shell to paint and the user to get their bearings. */
const APPEAR_AFTER_MS = 4000;
/** How long the confirmation stays up before the card retires itself. */
const CONFIRM_MS = 2600;

function snoozedUntil(): number {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function snooze(ms: number): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + ms));
  } catch {
    // Private mode. The prompt returns next session, which is the safe direction to
    // fail: a lost snooze is mildly annoying, a lost opt-in is silence forever.
  }
}

type Mode = 'ask' | 'install' | null;

/**
 * `install` is not a failure state. On iOS the push APIs exist only once the site
 * is on the Home Screen, so the useful prompt there is an instruction rather than
 * a permission request -- telling an iPhone user "unsupported" would be both wrong
 * and a dead end.
 */
function decideMode(): Mode {
  if (snoozedUntil() > Date.now()) {
    return null;
  }
  const status = currentWebPushStatus();
  if (status === 'ready' && canAskForNotifications()) {
    return 'ask';
  }
  if (status === 'needs-install') {
    return 'install';
  }
  return null;
}

export function NotificationPrompt() {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMode(decideMode()), APPEAR_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!done) {
      return;
    }
    const timer = setTimeout(() => setMode(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [done]);

  if (mode === null) {
    return null;
  }

  const dismiss = () => {
    // A "not now" is a week, not forever: push only proves its worth after you miss
    // something, so a first-day no is rarely the final answer. A native `denied` is
    // respected permanently instead -- only browser settings can undo that one, and
    // asking again cannot help.
    snooze(mode === 'install' ? MONTH : WEEK);
    setMode(null);
  };

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await enableNotifications();
      if (outcome.permission !== 'granted') {
        snooze(MONTH);
        setMode(null);
        return;
      }
      if (outcome.push === null || outcome.push.state === 'enabled') {
        setDone(true);
        return;
      }
      setError(
        outcome.push.state === 'failed'
          ? outcome.push.reason
          : `push is not available on this browser (${outcome.push.state === 'blocked' ? outcome.push.status : outcome.push.state})`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    // A region, not a dialog: it takes its own space at the top of the shell rather
    // than covering anything, and trapping focus over someone's inbox to offer them a
    // feature is how people learn to dismiss without reading.
    <div className="bc-push-prompt" role="region" aria-label="Notification settings">
      <div className="bc-push-prompt-icon" aria-hidden><Icon name="bell" size={20} /></div>
      <div className="bc-push-prompt-body">
        {done ? (
          <p className="bc-push-prompt-title">Notifications are on. You are all set.</p>
        ) : mode === 'install' ? (
          <>
            <p className="bc-push-prompt-title">Get notified when the app is closed</p>
            <p className="bc-push-prompt-text">
              On iPhone and iPad this needs the app on your Home Screen: tap Share, then “Add to
              Home Screen”, and open Banana Chat from there.
            </p>
          </>
        ) : (
          <>
            <p className="bc-push-prompt-title">Turn on notifications?</p>
            <p className="bc-push-prompt-text">
              Get a popup for new messages, mentions and incoming calls — even when Banana Chat is
              closed. You can turn it off any time from the bell.
            </p>
          </>
        )}
        {error !== null && <p className="bc-push-prompt-error">Could not turn them on: {error}</p>}
        {!done && (
          <div className="bc-push-prompt-actions">
            {mode === 'ask' && (
              <button className="bc-primary" onClick={() => void turnOn()} disabled={busy} data-testid="push-prompt-allow">
                {busy ? 'Turning on…' : 'Turn on'}
              </button>
            )}
            <button className="bc-push-prompt-later" onClick={dismiss} data-testid="push-prompt-dismiss">
              {mode === 'install' ? 'Got it' : 'Not now'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
