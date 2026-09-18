import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { UserStub } from '@banana-chat/shared';
import { useSession } from '../src/auth/session';
import { endpoints } from '../src/lib/api';
import { tr } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';

/**
 * Member directory + start a DM.
 *
 * Mobile previously had no way to BEGIN a conversation at all — `rooms.tsx` can
 * only open a room that already exists, so a user could reply to people but never
 * message anyone first. Web has had /members since PH1.
 *
 * Paginates with the same cursor endpoint the web directory uses.
 */
export default function MembersScreen() {
  const router = useRouter();
  const workspace = useSession((s) => s.currentWorkspace);
  const slug = workspace?.workspace.slug ?? '';
  const t = tr();

  const [search, setSearch] = useState('');
  const [members, setMembers] = useState<UserStub[]>([]);
  const [cursor, setCursor] = useState<string | null>('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(
    async (q: string, from: string) => {
      if (slug === '') return;
      setLoading(true);
      try {
        const page = await endpoints.directoryPage(slug, q, from);
        setMembers((prev) => (from === '' ? page.members : [...prev, ...page.members]));
        setCursor(page.next_cursor ?? null);
      } catch {
        if (from === '') setMembers([]);
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setCursor('');
      void load(search, '');
    }, 250);
    return () => clearTimeout(timer);
  }, [search, load]);

  const openDm = async (member: UserStub) => {
    if (slug === '' || opening !== null) return;
    setOpening(member.id);
    try {
      // createDm is idempotent server-side: an existing DM is returned rather than
      // a second one created, so this doubles as "open my DM with this person".
      const result = await endpoints.createDm(member.id, slug);
      router.push(`/room/${result.room.id}`);
    } catch {
      // stay on the list; the row simply stops spinning
    } finally {
      setOpening(null);
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        placeholder={t('members.search')}
        placeholderTextColor={theme.colors.textMuted}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {loading && members.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
      ) : (
        <FlashList
          data={members}
          keyExtractor={(m: UserStub) => m.id}
          onEndReached={() => {
            if (cursor !== null && cursor !== '' && !loading) void load(search, cursor);
          }}
          ListEmptyComponent={<Text style={styles.empty}>{t('members.empty')}</Text>}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => void openDm(item)} disabled={opening !== null}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(item.display_name || item.username || '?').slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.who}>
                <Text style={styles.name}>{item.display_name}</Text>
                <Text style={styles.handle}>@{item.username}</Text>
              </View>
              {opening === item.id && <ActivityIndicator color={theme.colors.primary} />}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  search: { backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, marginBottom: 10 },
  spinner: { marginTop: 24 },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.primary, fontWeight: '700', fontSize: 16 },
  who: { flex: 1 },
  name: { color: theme.colors.text, fontSize: 16 },
  handle: { color: theme.colors.textMuted, fontSize: 13 },
});
