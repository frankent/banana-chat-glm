import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { InAppNotification } from '@banana-chat/shared';
import { useSession } from '../src/auth/session';
import { endpoints } from '../src/lib/api';
import { tr } from '../src/lib/i18n';
import { formatTime, theme } from '../src/lib/theme';
import { getLocale } from '../src/lib/i18n';

/**
 * FR-NOTI-006 / API-073 — in-app notification centre.
 *
 * Rows have been written server-side since PH2 (NotifyMessage and three other
 * producers), and web has rendered them since PH4 — mobile simply never had the
 * screen, so a mobile-only user could not see mentions, room invites or
 * ticket-due alerts at all unless a push happened to arrive.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const workspace = useSession((s) => s.currentWorkspace);
  const slug = workspace?.workspace.slug ?? '';
  const t = tr();

  const [rows, setRows] = useState<InAppNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (from: string) => {
      if (slug === '') return;
      setLoading(true);
      try {
        const page = await endpoints.myNotifications(slug, from === '' ? undefined : from);
        setRows((prev) => (from === '' ? page.notifications : [...prev, ...page.notifications]));
        setCursor(page.next_cursor);
      } catch {
        if (from === '') setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const markAll = async () => {
    if (slug === '') return;
    const now = new Date().toISOString();
    // Optimistic: the list is the only thing this screen shows, so waiting on the
    // round trip just makes the tap feel broken.
    setRows((prev) => prev.map((r) => (r.read_at === null ? { ...r, read_at: now } : r)));
    try {
      await endpoints.markNotificationsRead(slug);
    } catch {
      void load('');
    }
  };

  const open = async (row: InAppNotification) => {
    if (row.read_at === null && slug !== '') {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, read_at: new Date().toISOString() } : r)));
      void endpoints.markNotificationsRead(slug, [row.id]).catch(() => undefined);
    }
    if (row.room_id !== null) {
      const seq = typeof row.data['seq'] === 'number' ? row.data['seq'] : undefined;
      router.push(seq !== undefined ? `/room/${row.room_id}?around_seq=${seq}` : `/room/${row.room_id}`);
    }
  };

  const title = (row: InAppNotification): string => {
    const who = row.actor?.display_name ?? '';
    switch (row.type) {
      case 'mention':
        return `${who} ${t('notifications.mentioned')}`;
      case 'added_to_room':
        return `${who} ${t('notifications.addedYou')}`;
      case 'session_revoked':
        return t('notifications.sessionRevoked');
      default:
        return who !== '' ? who : t('notifications.title');
    }
  };

  const unread = rows.filter((r) => r.read_at === null).length;

  return (
    <View style={styles.container}>
      {unread > 0 && (
        <Pressable style={styles.markAll} onPress={() => void markAll()}>
          <Text style={styles.markAllText}>{t('notifications.markAllRead')} ({unread})</Text>
        </Pressable>
      )}
      {loading && rows.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(r: InAppNotification) => r.id}
          onEndReached={() => {
            if (cursor !== null && cursor !== '' && !loading) void load(cursor);
          }}
          ListEmptyComponent={<Text style={styles.empty}>{t('notifications.empty')}</Text>}
          renderItem={({ item }) => (
            <Pressable style={[styles.row, item.read_at === null && styles.unreadRow]} onPress={() => void open(item)}>
              <Text style={styles.rowTitle}>{title(item)}</Text>
              <Text style={styles.rowTime}>{formatTime(item.created_at, getLocale())}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  markAll: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 4 },
  markAllText: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
  spinner: { marginTop: 24 },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 24 },
  row: { paddingVertical: 12, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, borderRadius: theme.radius },
  unreadRow: { backgroundColor: theme.colors.surfaceAlt },
  rowTitle: { color: theme.colors.text, fontSize: 15 },
  rowTime: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
});
