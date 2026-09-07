import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSession } from '../../src/auth/session';
import { useAiStore } from '../../src/ai/store';
import { Markdown } from '../../src/ai/Markdown';
import { tr } from '../../src/lib/i18n';
import { theme } from '../../src/lib/theme';

/**
 * TASK-MOB-016 — AI conversation screen: streaming bubbles (EVT-052), stop
 * (TC-MOB-050), retry on failure (TC-MOB-051), consent gate (FR-AI-019).
 */
export default function AiConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = typeof id === 'string' ? id : '';
  const workspace = useSession((s) => s.currentWorkspace);

  const messages = useAiStore((s) => s.messages[conversationId] ?? []);
  const sending = useAiStore((s) => s.sending);
  const consentOpen = useAiStore((s) => s.consentOpen);
  const streamTick = useAiStore((s) => s.streamTick);
  const open = useAiStore((s) => s.open);
  const send = useAiStore((s) => s.send);
  const cancel = useAiStore((s) => s.cancel);
  const retry = useAiStore((s) => s.retry);
  const closeConversation = useAiStore((s) => s.closeConversation);
  const giveConsent = useAiStore((s) => s.giveConsent);
  const setConsentOpen = useAiStore((s) => s.setConsentOpen);
  const activeStreamText = useAiStore((s) => s.activeStreamText);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const t = tr();
  void streamTick; // re-render on delta ticks

  useEffect(() => {
    if (workspace !== null && conversationId !== '') {
      void open(conversationId, workspace.workspace.slug);
    }
    return () => closeConversation();
  }, [workspace, conversationId, open, closeConversation]);

  const submit = async () => {
    const content = draft.trim();
    if (content === '' || workspace === null) {
      return;
    }
    setDraft('');
    await send(conversationId, workspace.workspace.slug, content);
  };

  const streamingMessage = [...messages].reverse().find((m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending'));
  const liveText = streamingMessage !== undefined ? activeStreamText(streamingMessage.id) : null;
  const failedMessage = [...messages].reverse().find((m) => m.status === 'failed');
  const lastUserContent = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.map((m) => {
          if (m.id === 'optimistic-user') {
            return (
              <View key={m.id} style={[styles.bubble, styles.mine]}>
                <Text style={styles.mineText}>{m.content}</Text>
              </View>
            );
          }
          if (m.role === 'user') {
            return (
              <View key={m.id} style={[styles.bubble, styles.mine]}>
                <Text style={styles.mineText}>{m.content}</Text>
              </View>
            );
          }
          const isStreaming = streamingMessage?.id === m.id;
          const body = isStreaming ? (liveText ?? m.content ?? '') : m.content ?? '';
          return (
            <View key={m.id} style={[styles.bubble, styles.theirs]}>
              {isStreaming ? (
                <Text style={styles.text}>
                  {body}
                  <Text style={styles.cursor}>▋</Text>
                </Text>
              ) : (
                // FR-AI-018 — completed answers render GFM (MarkdownFull)
                <Markdown content={body} />
              )}
              {m.status === 'failed' && (
                <View style={styles.failedRow}>
                  <Text style={styles.errorText}>{m.error_code ?? ''}</Text>
                  <Pressable onPress={() => workspace !== null && void retry(conversationId, workspace.workspace.slug, lastUserContent)}>
                    <Text style={styles.retryButton}>{t('ai.retry')}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={t('ai.placeholder')}
          placeholderTextColor={theme.colors.textMuted}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        {streamingMessage !== undefined ? (
          <Pressable
            style={styles.stopButton}
            onPress={() => workspace !== null && void cancel(streamingMessage.id, workspace.workspace.slug)}
          >
            <Text style={styles.stopText}>{t('ai.stop')}</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.sendButton} disabled={sending} onPress={() => void submit()}>
            <Text style={styles.sendText}>{t('composer.send')}</Text>
          </Pressable>
        )}
      </View>

      <Modal visible={consentOpen} transparent animationType="fade" onRequestClose={() => setConsentOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('ai.consent.title')}</Text>
            <Text style={styles.modalBody}>{t('ai.consent.body')}</Text>
            <Pressable
              style={styles.modalAccept}
              onPress={() => workspace !== null && void giveConsent(workspace.workspace.slug)}
            >
              <Text style={styles.modalAcceptText}>{t('ai.consent.accept')}</Text>
            </Pressable>
            <Pressable onPress={() => setConsentOpen(false)}>
              <Text style={styles.modalDecline}>{t('ai.consent.decline')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 12 },
  bubble: { maxWidth: '85%', borderRadius: theme.radius, padding: 12, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: theme.colors.primary },
  mineText: { color: '#0b1220', fontSize: 15 },
  theirs: { alignSelf: 'flex-start', backgroundColor: theme.colors.surface },
  text: { color: theme.colors.text, fontSize: 15 },
  cursor: { color: theme.colors.primary },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  errorText: { color: theme.colors.danger, fontSize: 12 },
  retryButton: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  input: { flex: 1, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, maxHeight: 120 },
  sendButton: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#0b1220', fontWeight: '700' },
  stopButton: { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: theme.colors.danger },
  stopText: { color: theme.colors.danger, fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: theme.colors.surface, borderRadius: theme.radius * 1.5, padding: 20, gap: 12 },
  modalTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  modalBody: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  modalAccept: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, padding: 14, alignItems: 'center' },
  modalAcceptText: { color: '#0b1220', fontWeight: '700' },
  modalDecline: { color: theme.colors.textMuted, textAlign: 'center', padding: 8 },
});
