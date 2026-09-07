import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError } from '@banana-chat/api-client';
import { useSession } from '../src/auth/session';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

export default function LoginScreen() {
  const router = useRouter();
  const login = useSession((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = tr();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password);
      if (result === 'must_change_password') {
        router.replace('/change-password');
      } else {
        router.replace('/rooms');
      }
    } catch (e) {
      setError(e instanceof ApiError ? t('login.error') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('app.name')}</Text>
      <TextInput
        style={styles.input}
        placeholder={t('login.username')}
        placeholderTextColor={theme.colors.textMuted}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder={t('login.password')}
        placeholderTextColor={theme.colors.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error !== null && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#0b1220" /> : <Text style={styles.buttonText}>{t('login.submit')}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center', gap: 12 },
  title: { color: theme.colors.primary, fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  input: { backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, padding: 14, fontSize: 16 },
  button: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, padding: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
  error: { color: theme.colors.danger, textAlign: 'center' },
});
