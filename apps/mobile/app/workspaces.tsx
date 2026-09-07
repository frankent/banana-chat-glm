import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { WorkspaceSummary } from '@banana-chat/shared';
import { useSession } from '../src/auth/session';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

/** TASK-MOB-002 — workspace switcher (switching keeps other ws caches). */
export default function WorkspacesScreen() {
  const router = useRouter();
  const workspaces = useSession((s) => s.workspaces);
  const current = useSession((s) => s.currentWorkspace);
  const switchWorkspace = useSession((s) => s.switchWorkspace);
  const t = tr();

  const pick = (slug: string) => {
    switchWorkspace(slug);
    router.replace('/rooms');
  };

  return (
    <View style={styles.container}>
      <FlashList
        data={workspaces}
        keyExtractor={(item: WorkspaceSummary) => item.workspace.id}
        renderItem={({ item }) => (
          <Pressable style={[styles.row, item.workspace.slug === current?.workspace.slug && styles.rowActive]} onPress={() => pick(item.workspace.slug)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.workspace.name}</Text>
              <Text style={styles.slug}>{item.workspace.slug}</Text>
            </View>
            {item.total_unread > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{item.total_unread}</Text></View>}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  row: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  rowActive: { borderWidth: 1, borderColor: theme.colors.primary },
  name: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  slug: { color: theme.colors.textMuted, fontSize: 13 },
  badge: { backgroundColor: theme.colors.primary, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { color: '#0b1220', fontWeight: '700', fontSize: 12, textAlign: 'center' },
});
