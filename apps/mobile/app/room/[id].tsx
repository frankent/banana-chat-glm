import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';
import { MessageStore, Outbox, RoomSync, ReadReceiptReporter, applyRoomEvent, type OutboxEntry } from '@banana-chat/chat-core';
import type { Message } from '@banana-chat/shared';
import { roomCache, scopedOutbox, useSession } from '../../src/auth/session';
import { endpoints } from '../../src/lib/api';
import { parseAroundSeq } from '../../src/lib/search-utils';
import { createOutboxSender } from '../../src/offline/outbox-flusher';
import { fileExists, uploadFile, uploadPart } from '../../src/offline/upload';
import { getLocale, tr } from '../../src/lib/i18n';
import { formatTime, theme } from '../../src/lib/theme';
import { watchRoom } from '../../src/realtime/echo';
import { setCurrentRoom } from '../../src/push/current-room';

/**
 * TASK-MOB-003/005 — chat screen: inverted FlashList over MessageStore,
 * composer with offline enqueue (pending clock icon, failed retry/delete —
 * TC-MOB-009/010/012), offline banner (TC-MOB-011).
 */
interface Row {
  key: string;
  message: Message | null;
  outbox: OutboxEntry | null;
}

export default function RoomScreen() {
  const { id, around_seq: aroundSeqParam } = useLocalSearchParams<{ id: string; around_seq?: string }>();
  const roomId = typeof id === 'string' ? id : '';
  const aroundSeq = parseAroundSeq(typeof aroundSeqParam === 'string' ? aroundSeqParam : undefined);
  const me = useSession((s) => s.me);
  const workspace = useSession((s) => s.currentWorkspace);

  const storeRef = useRef<MessageStore | null>(null);
  const outboxRef = useRef<Outbox | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const atLatest = useRef(true);
  const receiptRef = useRef<ReadReceiptReporter | null>(null);
  const [draft, setDraft] = useState('');
  const [online, setOnline] = useState(true);
  const t = tr();

  const rebuild = useCallback(() => {
    const store = storeRef.current;
    const outbox = outboxRef.current;
    if (store === null) {
      return;
    }
    const messages: Row[] = store.getState().messages.map((m) => ({ key: m.id, message: m, outbox: null }));
    const pending: Row[] = (outbox?.entriesForRoom(roomId) ?? []).map((e) => ({
      key: `outbox-${e.id}`,
      message: null,
      outbox: e,
    }));
    const confirmedIds = new Set(messages.map(row => row.message?.client_message_id));
    setRows([...messages, ...pending.filter(row => !confirmedIds.has(row.outbox?.client_message_id))].reverse());
  }, [roomId]);

  useEffect(() => {
    if (roomId === '' || workspace === null) {
      return;
    }
    // TC-MOB-031 — foreground pushes for this room are suppressed while open
    setCurrentRoom(roomId);
    const slug = workspace.workspace.slug;
    let active = true;
    const cache = roomCache();
    let ready = false;
    const store = new MessageStore(roomId, 10_000, () => {
      rebuild();
      if (active) {
        void cache?.saveMessages(roomId, store.getState().messages);
        receiptRef.current?.observe(store.newestSeq);
        if (store.getState().needsFill) void sync.refresh().catch(() => undefined);
      }
    });
    const sync = new RoomSync(store, options => endpoints.messages(roomId, slug, options), () => active);
    const reporter = new ReadReceiptReporter(seq => endpoints.markRead(roomId, slug, seq), () => active && atLatest.current && AppState.currentState === 'active' && aroundSeq === undefined);
    receiptRef.current = reporter;
    storeRef.current = store;
    const outbox = scopedOutbox() ?? new Outbox({ loadOutbox: async () => null, saveOutbox: async () => undefined });
    outboxRef.current = outbox;
    const unsub = outbox.subscribe(() => rebuild());
    outbox.setSender(createOutboxSender({ endpoints, uploadFile, uploadPart, fileExists }));
    // TC-CORE-027 — confirmed server message replaces the optimistic row
    outbox.onDelivered = (_entry, message) => {
      if (!active || message.room_id !== roomId) return;
      store.add(message);
      void cache?.saveMessages(roomId, store.getState().messages);
    };

    const unwatch = watchRoom(roomId, (name, data) => {
      if (!active) return;
      applyRoomEvent(store, name, data);
    }, connected => {
      if (!active) return;
      setOnline(connected);
      if (ready) outbox.setOnline(connected);
      if (connected && ready) void sync.refresh().catch(() => undefined);
    });
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active' && ready) {
        void sync.refresh().then(() => { if (active) { setOnline(true); outbox.setOnline(true); reporter.observe(store.newestSeq); } }).catch(() => { if (active) { setOnline(false); outbox.setOnline(false); } });
      }
    });
    void (async () => {
      await outbox.restore();
      if (!active) return;
      ready = true;
      // 1. cache first — instant paint (TC-MOB-001)
      const cached = await cache?.loadMessages(roomId);
      if (cached != null && storeRef.current === store) {
        if (store.getState().messages.length === 0) store.mergePage(cached);
      }
      rebuild();
      // 2. network sync — FR-SRCH-001 jump-to-result seeds around the hit
      try {
        const page = await endpoints.messages(
          roomId,
          slug,
          aroundSeq !== undefined && Number.isFinite(aroundSeq) ? { around_seq: aroundSeq } : {},
        );
        if (storeRef.current === store) {
          store.mergePage(page.messages);
          void cache?.saveMessages(roomId, store.getState().messages);
          const last = page.messages.at(-1);
          if (last !== undefined && me !== null && last.seq > 0) {
            reporter.observe(last.seq);
          }
        }
        if (!active) return;
        setOnline(true);
        outbox.setOnline(true);
      } catch {
        if (!active) return;
        setOnline(false);
        rebuild();
      }
    })();

    return () => {
      active = false;
      unwatch();
      appState.remove();
      reporter.dispose();
      setCurrentRoom(null);
      unsub();
      outbox.dispose();
      store.dispose();
      storeRef.current = null;
      outboxRef.current = null;
    };
  }, [roomId, workspace, me, rebuild, aroundSeq]);

  const send = async () => {
    const body = draft.trim();
    if (body === '' || outboxRef.current === null || workspace === null) {
      return;
    }
    setDraft('');
    await outboxRef.current.enqueue({ roomId, workspaceId: workspace.workspace.slug, body });
    rebuild(); // pending row shows immediately (TC-MOB-009)
  };

  return (
    <View style={styles.container}>
      {!online && <Text style={styles.offlineBanner}>{t('offline.banner')}</Text>}
      <FlashList
        data={rows}
        keyExtractor={(item: Row) => item.key}
        inverted
        onViewableItemsChanged={({ viewableItems }) => {
          atLatest.current = viewableItems.some(item => item.index === 0);
          receiptRef.current?.observe(storeRef.current?.newestSeq ?? 0);
        }}
        onEndReached={() => {
          const store = storeRef.current;
          const oldest = store?.getState().messages.at(0)?.seq;
          if (store && workspace && oldest && oldest > 1) void endpoints.messages(roomId, workspace.workspace.slug, { before_seq: oldest }).then(page => { if (storeRef.current === store) store.add(page.messages); }).catch(() => undefined);
        }}
        renderItem={({ item }) => {
          if (item.outbox !== null) {
            const failed = item.outbox.status === 'failed';
            return (
              <View style={[styles.bubble, styles.mine, failed && styles.failed]}>
                <Text style={styles.bubbleText}>{item.outbox.body ?? ''}</Text>
                {failed ? (
                  <View style={styles.failedActions}>
                    <Pressable onPress={() => void outboxRef.current?.retry(item.outbox!.id)}>
                      <Text style={styles.failedAction}>{t('outbox.retry')}</Text>
                    </Pressable>
                    <Pressable onPress={() => void outboxRef.current?.remove(item.outbox!.id)}>
                      <Text style={styles.failedAction}>{t('outbox.delete')}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.pendingText}>🕓 {t('outbox.pending')}</Text>
                )}
                {failed && item.outbox.last_error !== null && (
                  <Text style={styles.errorText}>{item.outbox.last_error}</Text>
                )}
              </View>
            );
          }
          const m = item.message!;
          const mine = m.sender_id === me?.id;
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {!mine && <Text style={styles.sender}>{m.sender?.display_name ?? m.sender_id}</Text>}
              <Text style={styles.bubbleText}>{m.deleted_at ? 'ข้อความถูกลบ' : m.body ?? ''}</Text>
              <Text style={styles.time}>{formatTime(m.created_at, getLocale())}</Text>
            </View>
          );
        }}
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={t('composer.placeholder')}
          placeholderTextColor={theme.colors.textMuted}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <Pressable style={styles.sendButton} onPress={() => void send()}>
          <Text style={styles.sendText}>{t('composer.send')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 8 },
  offlineBanner: { color: '#0b1220', backgroundColor: theme.colors.pending, textAlign: 'center', paddingVertical: 4, borderRadius: 8, marginBottom: 4, fontSize: 13 },
  bubble: { maxWidth: '80%', borderRadius: theme.radius, padding: 10, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: theme.colors.primary },
  theirs: { alignSelf: 'flex-start', backgroundColor: theme.colors.surface },
  failed: { backgroundColor: theme.colors.surfaceAlt, borderWidth: 1, borderColor: theme.colors.danger },
  sender: { color: theme.colors.primary, fontSize: 12, marginBottom: 2 },
  bubbleText: { color: theme.colors.text, fontSize: 15 },
  time: { color: theme.colors.textMuted, fontSize: 11, alignSelf: 'flex-end', marginTop: 2 },
  pendingText: { color: theme.colors.textMuted, fontSize: 11, marginTop: 2 },
  failedActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  failedAction: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
  errorText: { color: theme.colors.danger, fontSize: 12, flexShrink: 1 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  input: { flex: 1, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, maxHeight: 120 },
  sendButton: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#0b1220', fontWeight: '700' },
});
