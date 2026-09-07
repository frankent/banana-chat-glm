import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { RoomListItem } from '@banana-chat/shared';
import { useSession, roomCache } from '../src/auth/session';
import { endpoints } from '../src/lib/api';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

/**
 * TASK-MOB-003 — room list. Cache paints instantly, then the network sync
 * replaces (TC-MOB-001).
 */
export default function RoomsScreen() {
  const router = useRouter();
  const me = useSession((s) => s.me);
  const workspace = useSession((s) => s.currentWorkspace);
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const t = tr();

  const sync = useCallback(async () => {
    if (workspace === null) {
      return;
    }
    try {
      const fresh = await endpoints.rooms(workspace.workspace.slug, 'all');
      setRooms(fresh);
      void roomCache()?.saveRooms(fresh);
    } catch {
      // offline — cached list stays
    }
  }, [workspace]);

  useEffect(() => {
    void (async () => {
      const cached = await roomCache()?.loadRooms();
      if (cached !== null && cached !== undefined) {
        setRooms(cached);
      }
      await sync();
    })();
  }, [sync, me?.id]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.push('/workspaces')}>
          <Text style={styles.wsButton}>{workspace?.workspace.name ?? ''} ▾</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <Pressable onPress={() => router.push('/ai')}>
            <Text style={styles.navButton}>AI</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/settings')}>
            <Text style={styles.navButton}>⚙</Text>
          </Pressable>
        </View>
      </View>
      {rooms.length === 0 && <Text style={styles.empty}>{t('rooms.empty')}</Text>}
      <FlashList
        data={rooms}
        keyExtractor={(item: RoomListItem) => item.room.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await sync(); setRefreshing(false); }} tintColor={theme.colors.primary} />}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/room/${item.room.id}`)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.room.name ?? item.other_user?.display_name ?? item.room.id}</Text>
              <Text numberOfLines={1} style={styles.preview}>{item.last_message?.body ?? ''}</Text>
            </View>
            {item.unread_count > 0 && (
              <View style={styles.badge}><Text style={styles.badgeText}>{item.unread_count}</Text></View>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 8, marginBottom: 4 },
  wsButton: { color: theme.colors.text, fontSize: 17, fontWeight: '700' },
  navButton: { color: theme.colors.primary, fontSize: 16, fontWeight: '700' },
  row: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  name: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  preview: { color: theme.colors.textMuted, fontSize: 13, marginTop: 2 },
  badge: { backgroundColor: theme.colors.primary, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  badgeText: { color: '#0b1220', fontWeight: '700', fontSize: 12, textAlign: 'center' },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 32 },
});
