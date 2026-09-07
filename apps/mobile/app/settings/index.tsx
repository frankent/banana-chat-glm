import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useSession } from '../../src/auth/session';
import { appVersion, endpoints } from '../../src/lib/api';
import { getLocale } from '../../src/lib/i18n';
import { getOrCreateDeviceId } from '../../src/push/device-id';
import { clearPushToken, registerPushToken } from '../../src/push/registration';
import { tr } from '../../src/lib/i18n';
import { theme } from '../../src/lib/theme';

/**
 * TASK-MOB-010 — settings: push toggle (FR-NOTI-001/002, TC-MOB-033/035),
 * notification prefs link, logout.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const logout = useSession((s) => s.logout);
  const me = useSession((s) => s.me);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = tr();

  useEffect(() => {
    void Notifications.getPermissionsAsync().then((res) => setPushEnabled(res.granted));
  }, []);

  const pushDeps = {
    endpoints,
    getPushToken: async () => {
      try {
        const token = await Notifications.getDevicePushTokenAsync();
        return typeof token.data === 'string' ? token.data : JSON.stringify(token.data);
      } catch {
        return null;
      }
    },
    getDeviceId: getOrCreateDeviceId,
    getLocale,
    appVersion: appVersion(),
  };
  const platform = Platform.OS === 'ios' ? ('ios' as const) : ('android' as const);

  const togglePush = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(t('push.permissionDenied'));
          setPushEnabled(false);
          return;
        }
        const ok = await registerPushToken(pushDeps, platform);
        setPushEnabled(ok);
      } else {
        await clearPushToken(pushDeps, platform);
        setPushEnabled(false);
      }
    } catch {
      Alert.alert(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('settings.title')}</Text>
      <Text style={styles.who}>{me?.display_name ?? me?.username ?? ''}</Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>🔔 {t('settings.notifications')}</Text>
          {busy ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : (
            <Switch value={pushEnabled} onValueChange={(v) => void togglePush(v)} trackColor={{ true: theme.colors.primary }} />
          )}
        </View>
        <Pressable style={styles.linkRow} onPress={() => router.push('/settings/notifications')}>
          <Text style={styles.link}>{t('settings.notifications')} →</Text>
        </Pressable>
      </View>

      <Pressable style={styles.logout} onPress={() => void logout()}>
        <Text style={styles.logoutText}>{t('settings.logout')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 16 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: '700' },
  who: { color: theme.colors.textMuted, marginBottom: 8 },
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  label: { color: theme.colors.text, fontSize: 16 },
  linkRow: { padding: 16, borderTopWidth: 1, borderTopColor: theme.colors.border },
  link: { color: theme.colors.primary, fontSize: 16 },
  logout: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 16, alignItems: 'center', marginTop: 'auto' },
  logoutText: { color: theme.colors.danger, fontWeight: '700' },
});
