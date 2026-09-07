import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Linking } from 'react-native';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

/** TC-MOB-042 / BE-025 — 426 APP_UPDATE_REQUIRED: dead-end screen, no escape. */
export default function ForceUpdateScreen() {
  const t = tr();
  const openStore = () => {
    // store URLs ship with the release build config (QA-006 manual item)
    void Linking.openURL('itms-apps://itunes.apple.com/app/id000000000');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🍌</Text>
      <Text style={styles.body}>{t('update.required')}</Text>
      <Pressable style={styles.button} onPress={openStore}>
        <Text style={styles.buttonText}>{t('update.openStore')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center', alignItems: 'center', gap: 16 },
  title: { fontSize: 56 },
  body: { color: theme.colors.text, fontSize: 17, textAlign: 'center' },
  button: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, paddingVertical: 14, paddingHorizontal: 32 },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
});
