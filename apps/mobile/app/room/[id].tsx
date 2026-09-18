import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
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
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import type { OutboxAttachmentDraft } from '@banana-chat/chat-core';

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
  // TASK-MOB-009 — message actions. `actionsFor` drives the long-press sheet;
  // `replyTo` and `editing` are mutually exclusive composer modes.
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  // TASK-MOB-006 — staged attachments. The upload pipeline (createUpload ->
  // PUT -> completeUpload) already existed in outbox-flusher; only the picker
  // was missing, so a mobile user could never attach anything.
  const [pending, setPending] = useState<OutboxAttachmentDraft[]>([]);
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
    // An attachment-only message is legitimate (§10 renders a media badge for it),
    // so an empty body is only a reason to bail when nothing is staged either.
    if ((body === '' && pending.length === 0) || outboxRef.current === null || workspace === null) {
      return;
    }
    const slug = workspace.workspace.slug;

    // An edit is a direct PATCH, never an outbox entry: the outbox exists to make
    // a NEW message survive being offline, and replaying an edit against a message
    // whose body has since moved on would silently clobber someone else's change.
    if (editing !== null) {
      const target = editing;
      setBusy(true);
      try {
        const { message: updated } = await endpoints.editMessage(target.id, slug, body);
        storeRef.current?.add(updated);
        setEditing(null);
        setDraft('');
      } catch {
        // leave the draft in place so the text is not lost
      } finally {
        setBusy(false);
      }
      return;
    }

    setDraft('');
    const parent = replyTo;
    const files = pending;
    setReplyTo(null);
    setPending([]);
    await outboxRef.current.enqueue({
      roomId,
      workspaceId: slug,
      body,
      ...(parent !== null ? { replyToMessageId: parent.id } : {}),
      ...(files.length > 0 ? { attachments: files } : {}),
    });
    rebuild(); // pending row shows immediately (TC-MOB-009)
  };

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (result.canceled || result.assets.length === 0) return;
    setPending((prev) => [
      ...prev,
      ...result.assets.map((a) => ({
        local_path: a.uri,
        kind: (a.type === 'video' ? 'video' : 'image') as OutboxAttachmentDraft['kind'],
        mime_type: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
        original_name: a.fileName ?? `upload-${Date.now()}`,
        size_bytes: a.fileSize ?? 0,
      })),
    ]);
  };

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    setPending((prev) => [
      ...prev,
      ...result.assets.map((a) => ({
        local_path: a.uri,
        kind: 'file' as OutboxAttachmentDraft['kind'],
        mime_type: a.mimeType ?? 'application/octet-stream',
        original_name: a.name,
        size_bytes: a.size ?? 0,
      })),
    ]);
  };

  const removeMessage = async (message: Message) => {
    if (workspace === null) return;
    setBusy(true);
    try {
      await endpoints.deleteMessage(message.id, workspace.workspace.slug);
      // The server returns a tombstone via realtime; patch locally too so the row
      // updates even if the socket is down.
      storeRef.current?.add({ ...message, deleted_at: new Date().toISOString(), body: null });
    } catch {
      // ignore -- the row stays as-is and the user can retry
    } finally {
      setBusy(false);
    }
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
          const gone = m.deleted_at !== null;
          return (
            <Pressable
              onLongPress={() => { if (!gone) setActionsFor(m); }}
              delayLongPress={300}
              style={[styles.bubble, mine ? styles.mine : styles.theirs]}
            >
              {!mine && <Text style={styles.sender}>{m.sender?.display_name ?? m.sender_id}</Text>}
              {m.reply_to !== null && (
                <View style={styles.replyQuote}>
                  <Text style={styles.replyQuoteText} numberOfLines={1}>
                    {m.reply_to.deleted ? t('message.deleted') : m.reply_to.snippet ?? ''}
                  </Text>
                </View>
              )}
              {m.attachments.length > 0 && !gone && (
                <View style={styles.attachments}>
                  {m.attachments.map((a) => (
                    // thumb_md first: the original can be many MB and this list is
                    // inverted and virtualised, so full-size decodes would jank scroll.
                    a.kind === 'image' && (a.urls.thumb_md ?? a.urls.original) !== null
                      ? <Image key={a.id} source={{ uri: (a.urls.thumb_md ?? a.urls.original)! }} style={styles.attachmentImage} resizeMode="cover" />
                      : <Text key={a.id} style={styles.attachmentFile}>📎 {a.original_name}</Text>
                  ))}
                </View>
              )}
              {(m.body !== null && m.body !== '') || gone ? (
                <Text style={[styles.bubbleText, gone && styles.deletedText]}>
                  {gone ? t('message.deleted') : m.body}
                </Text>
              ) : null}
              <View style={styles.metaRow}>
                {m.edited_at !== null && !gone && <Text style={styles.meta}>{t('message.edited')}</Text>}
                <Text style={styles.time}>{formatTime(m.created_at, getLocale())}</Text>
              </View>
            </Pressable>
          );
        }}
      />
      {(replyTo !== null || editing !== null) && (
        <View style={styles.composerChip}>
          <Text style={styles.composerChipText} numberOfLines={1}>
            {editing !== null
              ? t('message.editing')
              : `${t('message.replyingTo')}: ${replyTo?.body ?? ''}`}
          </Text>
          <Pressable onPress={() => { setReplyTo(null); setEditing(null); setDraft(''); }}>
            <Text style={styles.composerChipCancel}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      )}
      {pending.length > 0 && (
        <View style={styles.pendingStrip}>
          {pending.map((a, i) => (
            <Pressable key={`${a.local_path}-${i}`} onPress={() => setPending((p) => p.filter((_, j) => j !== i))}>
              <Text style={styles.pendingChip} numberOfLines={1}>
                {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎬' : '📎'} {a.original_name}  ✕
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.composer}>
        <Pressable style={styles.attachButton} onLongPress={() => void pickDocument()} onPress={() => void pickImage()}>
          <Text style={styles.attachText}>＋</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder={t('composer.placeholder')}
          placeholderTextColor={theme.colors.textMuted}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <Pressable style={styles.sendButton} disabled={busy} onPress={() => void send()}>
          {busy ? <ActivityIndicator color="#0b1220" /> : <Text style={styles.sendText}>{t('composer.send')}</Text>}
        </Pressable>
      </View>

      {/* Long-press action sheet. Edit and Delete are offered only for your own
          messages -- the server enforces it too, but showing an action that is
          guaranteed to 403 is worse than not showing it. */}
      <Modal visible={actionsFor !== null} transparent animationType="fade" onRequestClose={() => setActionsFor(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionsFor(null)}>
          <View style={styles.sheet}>
            <Pressable style={styles.sheetItem} onPress={() => { setReplyTo(actionsFor); setEditing(null); setActionsFor(null); }}>
              <Text style={styles.sheetText}>{t('message.reply')}</Text>
            </Pressable>
            {actionsFor?.sender_id === me?.id && (
              <>
                <Pressable style={styles.sheetItem} onPress={() => { setEditing(actionsFor); setReplyTo(null); setDraft(actionsFor?.body ?? ''); setActionsFor(null); }}>
                  <Text style={styles.sheetText}>{t('message.edit')}</Text>
                </Pressable>
                <Pressable style={styles.sheetItem} onPress={() => { const m = actionsFor; setActionsFor(null); if (m) void removeMessage(m); }}>
                  <Text style={[styles.sheetText, styles.sheetDanger]}>{t('message.delete')}</Text>
                </Pressable>
              </>
            )}
            <Pressable style={styles.sheetItem} onPress={() => setActionsFor(null)}>
              <Text style={styles.sheetMuted}>{t('common.cancel')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
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
  replyQuote: { borderLeftWidth: 3, borderLeftColor: theme.colors.primary, paddingLeft: 8, marginBottom: 4, opacity: 0.85 },
  replyQuoteText: { color: theme.colors.textMuted, fontSize: 13 },
  attachments: { gap: 6, marginBottom: 6 },
  attachmentImage: { width: 200, height: 150, borderRadius: 8, backgroundColor: theme.colors.surfaceAlt },
  attachmentFile: { color: theme.colors.text, fontSize: 14 },
  deletedText: { fontStyle: 'italic', color: theme.colors.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end', marginTop: 2 },
  meta: { color: theme.colors.textMuted, fontSize: 11, fontStyle: 'italic' },
  composerChip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius, paddingHorizontal: 12, paddingVertical: 8, marginTop: 8 },
  composerChipText: { color: theme.colors.textMuted, fontSize: 13, flex: 1 },
  composerChipCancel: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingVertical: 8 },
  sheetItem: { paddingVertical: 16, paddingHorizontal: 20 },
  sheetText: { color: theme.colors.text, fontSize: 16 },
  sheetDanger: { color: theme.colors.danger },
  sheetMuted: { color: theme.colors.textMuted, fontSize: 16 },
  pendingStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 8 },
  pendingChip: { color: theme.colors.text, backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, maxWidth: 200 },
  attachButton: { backgroundColor: theme.colors.surface, borderRadius: theme.radius, paddingHorizontal: 14, paddingVertical: 10 },
  attachText: { color: theme.colors.primary, fontSize: 20, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  input: { flex: 1, backgroundColor: theme.colors.surface, color: theme.colors.text, borderRadius: theme.radius, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, maxHeight: 120 },
  sendButton: { backgroundColor: theme.colors.primary, borderRadius: theme.radius, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#0b1220', fontWeight: '700' },
});
