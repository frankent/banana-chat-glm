import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { canRingCall } from '@banana-chat/chat-core';
import type { RoomCall } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { watchCalls } from '../realtime/echo';
import { theme } from '../lib/theme';

function Ringtone() {
  const player = useAudioPlayer(require('../../assets/incoming-call.wav'));
  useEffect(() => {
    let cancelled = false;
    void setAudioModeAsync({ playsInSilentMode: false, shouldPlayInBackground: false })
      .then(() => {
        if (cancelled) return;
        player.loop = true;
        player.volume = .8;
        player.play();
      })
      .catch(() => { /* The visual incoming-call alert remains available. */ });
    return () => { cancelled = true; player.pause(); };
  }, [player]);
  return null;
}

/** Foreground only. Native background calling requires separate push integration. */
export function IncomingCallAlert({ userId, slug }: { userId: string; slug: string }) {
  const insets = useSafeAreaInsets();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [calls, setCalls] = useState<RoomCall[]>([]);
  const [now, setNow] = useState(Date.now);
  const [silenced, setSilenced] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setCalls([]);
      setNow(Date.now());
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!foreground) return;
    let cancelled = false;
    let inFlight = false;
    let again = false;
    const refresh = async () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const result = await endpoints.calls(slug);
        if (!cancelled) setCalls(result.enabled ? result.calls : []);
      } catch {
        // Never keep ringing a stale call when its state cannot be confirmed.
        if (!cancelled) setCalls([]);
      } finally {
        inFlight = false;
        if (again && !cancelled) { again = false; void refresh(); }
      }
    };
    void refresh();
    const unsubscribe = watchCalls(() => { void refresh(); });
    const poll = setInterval(() => { void refresh(); }, 5000);
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => { cancelled = true; unsubscribe(); clearInterval(poll); clearInterval(clock); };
  }, [foreground, slug]);

  const incoming = foreground ? calls.find((call) =>
    call.room_type === 'dm' && !call.ended_at && !dismissed.includes(call.id)
      && canRingCall(call, userId, now),
  ) : undefined;

  if (!incoming) return error ? (
    <Pressable accessibilityRole="button" onPress={() => setError('')} style={[styles.alert, { bottom: insets.bottom + 12 }]}>
      <Text style={styles.text}>{error} Tap to dismiss.</Text>
    </Pressable>
  ) : null;

  return (
    <View accessibilityLiveRegion="assertive" style={[styles.alert, { bottom: insets.bottom + 12 }]}>
      {!silenced.includes(incoming.id) && <Ringtone key={incoming.id} />}
      <Text style={styles.title}>{incoming.caller_name}</Text>
      <Text style={styles.text}>Incoming {incoming.kind} call</Text>
      <Text style={styles.hint}>Answer in the web app. Native answering is not available yet.</Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Silence ringtone"
          disabled={silenced.includes(incoming.id)} style={styles.button}
          onPress={() => setSilenced((ids) => [...ids, incoming.id])}>
          <Text style={styles.text}>{silenced.includes(incoming.id) ? 'Silenced' : 'Silence'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Decline call" style={[styles.button, styles.decline]}
          onPress={() => {
            setDismissed((ids) => [...ids, incoming.id]);
            void endpoints.callAction(incoming.id, 'decline', slug).catch(() => {
              setError('Could not decline the call. The ringtone is silenced on this device.');
            });
          }}>
          <Text style={styles.text}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  alert: { position: 'absolute', left: 12, right: 12, padding: 16, gap: 8,
    backgroundColor: theme.colors.surface, borderRadius: theme.radius,
    borderWidth: 1, borderColor: theme.colors.primary, elevation: 12, zIndex: 100 },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
  text: { color: theme.colors.text, fontSize: 14 },
  hint: { color: theme.colors.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 12 },
  button: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt, borderRadius: 8 },
  decline: { backgroundColor: '#9f2525' },
});
