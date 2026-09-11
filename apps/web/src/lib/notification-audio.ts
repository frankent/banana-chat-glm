/** FR-NOTI-007: unlock only inside a trusted gesture; never replay blocked alerts. */
let context: AudioContext | undefined;
export function unlockNotificationAudio() {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  } catch { /* Browser does not support Web Audio. */ }
}
export function playNotificationAudio() {
  if (context?.state !== 'running') return;
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.connect(gain); gain.connect(context.destination);
  oscillator.frequency.setValueAtTime(880, now);
  oscillator.frequency.setValueAtTime(1174.66, now + .09);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(.08, now + .015);
  gain.gain.exponentialRampToValueAtTime(.001, now + .24);
  oscillator.start(now); oscillator.stop(now + .25);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
