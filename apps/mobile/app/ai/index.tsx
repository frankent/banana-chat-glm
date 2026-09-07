import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import type { AiConversationSummary } from '@banana-chat/shared';
import { useSession } from '../../src/auth/session';
import { useAiStore } from '../../src/ai/store';
import { endpoints } from '../../src/lib/api';
import { tr } from '../../src/lib/i18n';
import { theme } from '../../src/lib/theme';

/** TASK-MOB-015 — AI conversation list (cache-first, TC-MOB-056). */
export default function AiIndexScreen() {
  const router = useRouter();
  const workspace = useSession((s) => s.currentWorkspace);
  const conversations = useAiStore((s) => s.conversations);
  const loadConversations = useAiStore((s) => s.loadConversations);
  const newConversation = useAiStore((s) => s.newConversation);
  const t = tr();

  useEffect(() => {
    if (workspace !== null) {
      void loadConversations(workspace.workspace.slug);
    }
  }, [workspace, loadConversations]);

  const start = async () => {
    if (workspace === null) {
      return;
    }
    const id = await newConversation(workspace.workspace.slug);
    if (id !== null) {
      router.push(`/ai/${id}`);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ {t('rooms.title')}</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/ai/memory')}>
          <Text style={styles.memButton}>{t('ai.memories')}</Text>
        </Pressable>
      </View>
      <Pressable style={styles.newButton} onPress={() => void start()}>
        <Text style={styles.newButtonText}>＋ {t('ai.newChat')}</Text>
      </Pressable>
      <FlashList
        data={conversations}
        keyExtractor={(item: AiConversationSummary) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/ai/${item.id}`)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{item.title ?? t('ai.newChat')}</Text>
              <Text style={styles.meta}>{item.message_count} · {item.last_message_at ?? ''}</Text>
            </View>
            {item.generating && <Text style={styles.generating}>…</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 8 },
  back: { color: theme.colors.primary, fontSize: 16, fontWeight: '600' },
  memButton: { color: theme.colors.primary, fontSize: 14 },
  newButton: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, padding: 14, alignItems: 'center', marginVertical: 8 },
  newButtonText: { color: '#0b1220', fontWeight: '700' },
  row: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 14, marginBottom: 8 },
  title: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  generating: { color: theme.colors.pending },
});
