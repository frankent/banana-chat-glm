import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSession } from '../../src/auth/session';
import { endpoints } from '../../src/lib/api';
import { tr } from '../../src/lib/i18n';
import { theme } from '../../src/lib/theme';

/**
 * TASK-MOB-010 — global notification prefs (API-072): DND window + days,
 * sound, push preview. Write-only form — values apply on save.
 */
const DAYS = [
  { label: 'MO', value: 1 },
  { label: 'TU', value: 2 },
  { label: 'WE', value: 3 },
  { label: 'TH', value: 4 },
  { label: 'FR', value: 5 },
  { label: 'SA', value: 6 },
  { label: 'SU', value: 7 },
];

export default function NotificationSettingsScreen() {
  const workspace = useSession((s) => s.currentWorkspace);
  const [dndStart, setDndStart] = useState('');
  const [dndEnd, setDndEnd] = useState('');
  const [dndDays, setDndDays] = useState<number[]>([]);
  const [sound, setSound] = useState(true);
  const [preview, setPreview] = useState(true);
  const [saved, setSaved] = useState(false);
  const t = tr();

  const toggleDay = (day: number) => {
    setSaved(false);
    setDndDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const save = async () => {
    if (workspace === null) {
      return;
    }
    const hasStart = dndStart.trim() !== '';
    const hasEnd = dndEnd.trim() !== '';
    if (hasStart !== hasEnd) {
      return; // backend rejects half a window (API-072 validation)
    }
    await endpoints.notificationSettings(workspace.workspace.slug, {
      ...(hasStart ? { dnd_start: dndStart.trim(), dnd_end: dndEnd.trim() } : {}),
      ...(dndDays.length > 0 ? { dnd_days: dndDays } : {}),
      sound,
      preview_in_push: preview,
    });
    setSaved(true);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('settings.notifications')}</Text>

      <View style={styles.card}>
        <Text style={styles.section}>DND (22:00 – 07:00)</Text>
        <View style={styles.dndRow}>
          <TextInput style={styles.timeInput} placeholder="22:00" placeholderTextColor={theme.colors.textMuted} value={dndStart} onChangeText={(v) => { setDndStart(v); setSaved(false); }} />
          <Text style={styles.dash}>–</Text>
          <TextInput style={styles.timeInput} placeholder="07:00" placeholderTextColor={theme.colors.textMuted} value={dndEnd} onChangeText={(v) => { setDndEnd(v); setSaved(false); }} />
        </View>
        <View style={styles.daysRow}>
          {DAYS.map((d) => (
            <Pressable
              key={d.value}
              style={[styles.day, dndDays.includes(d.value) && styles.dayActive]}
              onPress={() => toggleDay(d.value)}
            >
              <Text style={[styles.dayText, dndDays.includes(d.value) && styles.dayTextActive]}>{d.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <Text style={styles.label}>🔊 Sound</Text>
          <Switch value={sound} onValueChange={(v) => { setSound(v); setSaved(false); }} trackColor={{ true: theme.colors.primary }} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.label}>👁 Preview in push</Text>
          <Switch value={preview} onValueChange={(v) => { setPreview(v); setSaved(false); }} trackColor={{ true: theme.colors.primary }} />
        </View>
      </View>

      <Pressable style={styles.save} onPress={() => void save()}>
        <Text style={styles.saveText}>{t('changePassword.submit')}</Text>
      </Pressable>
      {saved && <Text style={styles.saved}>✓</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 16, gap: 12 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: '700', marginBottom: 4 },
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 16, gap: 12 },
  section: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '600' },
  dndRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeInput: { flex: 1, backgroundColor: theme.colors.surfaceAlt, color: theme.colors.text, borderRadius: 8, padding: 10, fontSize: 16, textAlign: 'center' },
  dash: { color: theme.colors.textMuted }  ,
  daysRow: { flexDirection: 'row', gap: 6 },
  day: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  dayActive: { backgroundColor: theme.colors.primary },
  dayText: { color: theme.colors.textMuted, fontSize: 11, fontWeight: '700' },
  dayTextActive: { color: '#0b1220' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: theme.colors.text, fontSize: 16 },
  save: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, padding: 14, alignItems: 'center' },
  saveText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
  saved: { color: theme.colors.primary, textAlign: 'center', fontSize: 18 },
});
