import { useEffect, useState } from 'react';
import { startIncomingRingtone, unlockNotificationAudio } from '../../lib/notification-audio';

export function IncomingRingtone({ createdAt }: { createdAt: string }) {
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (muted) return;
    return startIncomingRingtone(Date.parse(createdAt) + 60_000, setBlocked);
  }, [createdAt, muted]);
  if (muted) return <span role="status">Ringtone silenced</span>;
  return blocked ? (
    <button onClick={unlockNotificationAudio}>Enable ringtone</button>
  ) : (
    <button onClick={() => setMuted(true)}>Silence ringtone</button>
  );
}
