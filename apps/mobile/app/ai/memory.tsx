import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import type { AiMemory } from '@banana-chat/shared';
import { useSession } from '../../src/auth/session';
import { endpoints } from '../../src/lib/api';
import { tr } from '../../src/lib/i18n';
import { theme } from '../../src/lib/theme';

/** TASK-MOB-017 — AI memories: list + clear-all (FR-AI-016, API-114). */
export default function AiMemoryScreen() {
  const workspace = useSession((s) => s.currentWorkspace);
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const t = tr();

  const load = useCallback(async () => {
    if (workspace === null) {
      return;
    }
    try {
      const res = await endpoints.aiMemories(workspace.workspace.slug);
      setMemories(res.memories);
    } catch {
      // offline — keep whatever is on screen
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearAll = () => {
    Alert.alert(t('ai.memories.clear'), '', [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.ok'),
        onPress: () => {
          if (workspace !== null) {
            void endpoints.aiClearMemories(workspace.workspace.slug).then(load);
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('ai.memories')}</Text>
        {memories.length > 0 && (
          <Pressable onPress={clearAll}>
            <Text style={styles.clear}>{t('ai.memories.clear')}</Text>
          </Pressable>
        )}
      </View>
      {memories.length === 0 && <Text style={styles.empty}>{t('ai.memories.empty')}</Text>}
      <FlashList
        data={memories}
        keyExtractor={(item: AiMemory) => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.content}>{item.content}</Text>
            <Text style={styles.meta}>{item.category} · ★{item.importance}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 8 },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
  clear: { color: theme.colors.danger, fontSize: 14, fontWeight: '600' },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 32 },
  row: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, padding: 14, marginBottom: 8 },
  content: { color: theme.colors.text, fontSize: 15 },
  meta: { color: theme.colors.textMuted, fontSize: 12, marginTop: 4 },
});
