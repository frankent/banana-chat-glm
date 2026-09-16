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

let stopRingtone: (() => void) | undefined;

export function stopIncomingRingtone() {
  stopRingtone?.();
}

/** FR-CALL-001: incoming DM only; never unlock audio without a user gesture. */
export function startIncomingRingtone(expiresAt: number, onBlocked: (blocked: boolean) => void) {
  stopIncomingRingtone();
  const voices = new Set<OscillatorNode>();
  let stopped = false;
  let nextRing = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const voice of voices) {
      try { voice.stop(); } catch { /* Already ended. */ }
      voice.disconnect();
    }
    voices.clear();
    if (stopRingtone === stop) stopRingtone = undefined;
  };
  const tick = () => {
    if (Date.now() >= expiresAt) { stop(); return; }
    const audio = context;
    onBlocked(!audio || audio.state !== 'running');
    if (!audio || audio.state !== 'running' || Date.now() < nextRing) return;
    nextRing = Date.now() + 2400;
    // Two short dual-frequency pulses, followed by a quiet interval.
    for (const delay of [0, .45]) {
      for (const frequency of [440, 480]) {
        const voice = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + delay;
        voice.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(.045, start + .02);
        gain.gain.setValueAtTime(.045, start + .28);
        gain.gain.linearRampToValueAtTime(0, start + .32);
        voice.connect(gain);
        gain.connect(audio.destination);
        voices.add(voice);
        voice.onended = () => { voices.delete(voice); voice.disconnect(); gain.disconnect(); };
        voice.start(start);
        voice.stop(start + .33);
      }
    }
  };
  stopRingtone = stop;
  timer = setInterval(tick, 200);
  tick();
  return stop;
}
