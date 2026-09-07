import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { endpoints } from '../src/lib/api';
import { tokenManager } from '../src/lib/api';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

/** TASK-MOB-002 — FR-AUTH-005 forced password change. */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = tr();

  const submit = async () => {
    if (next !== confirm) {
      setError(t('common.error'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.changePassword(current, next);
      tokenManager.clear();
      router.replace('/login');
    } catch {
      setError(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('changePassword.title')}</Text>
      <TextInput style={styles.input} placeholder={t('changePassword.current')} placeholderTextColor={theme.colors.textMuted} secureTextEntry value={current} onChangeText={setCurrent} />
      <TextInput style={styles.input} placeholder={t('changePassword.new')} placeholderTextColor={theme.colors.textMuted} secureTextEntry value={next} onChangeText={setNext} />
      <TextInput style={styles.input} placeholder={t('changePassword.confirm')} placeholderTextColor={theme.colors.textMuted} secureTextEntry value={confirm} onChangeText={setConfirm} />
      {error !== null && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#0b1220" /> : <Text style={styles.buttonText}>{t('changePassword.submit')}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center', gap: 12 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  input: { backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, padding: 14, fontSize: 16 },
  button: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, padding: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
  error: { color: theme.colors.danger, textAlign: 'center' },
});
