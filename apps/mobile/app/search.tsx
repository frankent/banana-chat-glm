import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { FileSearchResult, MessageSearchResult } from '@banana-chat/shared';
import { useSession } from '../src/auth/session';
import { endpoints } from '../src/lib/api';
import { isSearchable, stripMarks } from '../src/lib/search-utils';
import { theme } from '../src/lib/theme';

type Mode = 'messages' | 'files';

interface Row {
  key: string;
  message: MessageSearchResult | null;
  file: FileSearchResult | null;
}

/**
 * TASK-MOB-014 — global search (FR-SRCH-001/002, API-080/081). Tapping a
 * result jumps to the room seeded around the hit (?around_seq=).
 */
export default function SearchScreen() {
  const router = useRouter();
  const workspace = useSession((s) => s.currentWorkspace);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('messages');
  const [kind, setKind] = useState<'image' | 'video' | 'file' | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const slug = workspace?.workspace.slug;
  const trimmed = useMemo(() => q.trim(), [q]);

  const run = useCallback(
    async (cursor?: string) => {
      if (slug === undefined || trimmed.length < 2) {
        return;
      }
      setLoading(true);
      try {
        if (mode === 'messages') {
          const page = await endpoints.searchMessages(slug, { q: trimmed, cursor });
          const fresh: Row[] = page.results.map((r) => ({ key: r.message.id, message: r, file: null }));
          setRows((prev) => (cursor === undefined ? fresh : [...prev, ...fresh]));
          setNextCursor(page.next_cursor);
        } else {
          const page = await endpoints.searchFiles(slug, { q: trimmed, kind: kind ?? undefined, cursor });
          const fresh: Row[] = page.results.map((r) => ({ key: `${r.attachment.id}-${r.message.id}`, message: null, file: r }));
          setRows((prev) => (cursor === undefined ? fresh : [...prev, ...fresh]));
          setNextCursor(page.next_cursor);
        }
        setSearched(true);
      } catch {
        // network error — keep whatever is on screen
      } finally {
        setLoading(false);
      }
    },
    [slug, trimmed, mode, kind],
  );

  // debounced live search
  useEffect(() => {
    if (trimmed.length < 2) {
      setRows([]);
      setNextCursor(null);
      setSearched(false);
      return;
    }
    const timer = setTimeout(() => void run(), 350);
    return () => clearTimeout(timer);
  }, [trimmed, run]);

  const open = (row: Row) => {
    if (row.message !== null) {
      router.push(`/room/${row.message.message.room_id}?around_seq=${row.message.message.seq}`);
    } else if (row.file !== null) {
      router.push(`/room/${row.file.message.room_id}?around_seq=${row.file.message.seq}`);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="ค้นหาข้อความหรือไฟล์…"
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
          accessibilityLabel="Search messages and files"
          returnKeyType="search"
          onSubmitEditing={() => void run()}
        />
      </View>

      <View style={styles.tabs}>
        {(['messages', 'files'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === value }}
            onPress={() => setMode(value)}
            style={[styles.tab, mode === value && styles.tabActive]}
          >
            <Text style={[styles.tabText, mode === value && styles.tabTextActive]}>{value === 'messages' ? 'ข้อความ' : 'ไฟล์'}</Text>
          </Pressable>
        ))}
      </View>

      {mode === 'files' && (
        <View style={styles.kinds}>
          {(
            [
              [null, 'ทั้งหมด'],
              ['image', 'รูป'],
              ['video', 'วิดีโอ'],
              ['file', 'ไฟล์'],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              onPress={() => setKind(value)}
              style={[styles.kindChip, kind === value && styles.kindChipActive]}
            >
              <Text style={[styles.kindText, kind === value && styles.kindTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading && rows.length === 0 && <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 24 }} />}
      {!loading && !isSearchable(trimmed) && <Text style={styles.empty}>พิมพ์อย่างน้อย 2 ตัวอักษร</Text>}
      {!loading && searched && rows.length === 0 && isSearchable(trimmed) && <Text style={styles.empty}>ไม่พบผลลัพธ์</Text>}

      <FlashList
        data={rows}
        keyExtractor={(item: Row) => item.key}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" style={styles.row} onPress={() => open(item)}>
            {item.message !== null ? (
              <>
                <Text style={styles.meta}>
                  {item.message.room?.name ?? 'DM'} · {item.message.message.sender?.display_name ?? ''} ·{' '}
                  {new Date(item.message.message.created_at).toLocaleDateString()}
                </Text>
                <Text numberOfLines={2} style={styles.body}>
                  {stripMarks(item.message.highlight)}
                </Text>
              </>
            ) : item.file !== null ? (
              <>
                <Text style={styles.body}>
                  {item.file.attachment.kind === 'image' ? '🖼' : item.file.attachment.kind === 'video' ? '🎬' : '📄'}{' '}
                  {item.file.attachment.original_name}
                </Text>
                <Text style={styles.meta}>
                  {item.file.room?.name ?? 'DM'} · {(item.file.attachment.size_bytes / 1024).toFixed(0)} KB
                </Text>
              </>
            ) : null}
          </Pressable>
        )}
        ListFooterComponent={
          nextCursor !== null ? (
            <Pressable accessibilityRole="button" style={styles.more} onPress={() => void run(nextCursor)}>
              <Text style={styles.moreText}>โหลดเพิ่ม</Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  back: { color: theme.colors.primary, fontSize: 26, fontWeight: '700', paddingHorizontal: 4 },
  input: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.text,
    fontSize: 15,
  },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { color: theme.colors.textMuted, fontWeight: '600', fontSize: 13 },
  tabTextActive: { color: '#0b1220' },
  kinds: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  kindChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: theme.colors.surface },
  kindChipActive: { backgroundColor: theme.colors.primary },
  kindText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '600' },
  kindTextActive: { color: '#0b1220' },
  row: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 12, marginBottom: 8 },
  meta: { color: theme.colors.textMuted, fontSize: 12, marginBottom: 2 },
  body: { color: theme.colors.text, fontSize: 14 },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 32 },
  more: { alignSelf: 'center', padding: 10 },
  moreText: { color: theme.colors.primary, fontWeight: '600' },
});
