import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Image, type HostInstance, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomRosterMember, UserStub } from '@banana-chat/shared';
import { roomCache, useSession } from '../auth/session';
import { endpoints } from '../lib/api';
import { tr } from '../lib/i18n';
import { theme } from '../lib/theme';
import { ProfileDmFlow, type DmFlowSnapshot } from './dm-flow';

interface Props {
  user: UserStub;
  roster?: RoomRosterMember;
  isSelf: boolean;
  slug: string;
  onClose(): void;
  onNavigate(roomId: string): void;
}

/** FR-PROF-009 / DEC-101 — one mounted sheet owns one disposable DM flow. */
export function ProfileSheet({ user, roster, isSelf, slug, onClose, onNavigate }: Props) {
  const t = tr();
  const insets = useSafeAreaInsets();
  const flowRef = useRef<ProfileDmFlow | null>(null);
  const callbacks = useRef({ onClose, onNavigate });
  callbacks.current = { onClose, onNavigate };
  const [snapshot, setSnapshot] = useState<DmFlowSnapshot>({ busy: false, state: isSelf ? 'self' : 'idle' });
  const [failedUri, setFailedUri] = useState<string>();
  const dmButton = useRef<HostInstance>(null);
  const nameRef = useRef<HostInstance>(null);
  const uri = user.avatar?.md;

  useEffect(() => {
    const flow = new ProfileDmFlow({
      createDm: (userId, workspaceSlug) => endpoints.createDm(userId, workspaceSlug),
      cachedRooms: () => roomCache()?.loadRooms() ?? Promise.resolve(null),
      refreshRooms: async workspaceSlug => {
        // Capture the scoped adapter before awaiting, so a switch cannot write
        // the previous workspace's rooms into the next workspace's cache.
        if (useSession.getState().currentWorkspace?.workspace.slug !== workspaceSlug) return;
        const cache = roomCache();
        const rooms = await endpoints.rooms(workspaceSlug, 'all');
        await cache?.saveRooms(rooms);
      },
      currentSlug: () => useSession.getState().currentWorkspace?.workspace.slug,
      navigate: roomId => {
        if (useSession.getState().currentWorkspace?.workspace.slug !== slug) return;
        flow.dispose();
        callbacks.current.onNavigate(roomId);
      },
    }, user.id, slug, isSelf, setSnapshot);
    flowRef.current = flow;
    setSnapshot(flow.snapshot);
    return () => { flow.dispose(); flowRef.current = null; };
  }, [user.id, slug, isSelf]);

  // Screen readers start on the sheet's primary action (Chat 1-1), or the name when there is none.
  useEffect(() => {
    const timer = setTimeout(() => {
      const node = findNodeHandle(dmButton.current ?? nameRef.current);
      if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
    }, 350);
    return () => clearTimeout(timer);
  }, []);

  const close = () => {
    flowRef.current?.dispose();
    callbacks.current.onClose();
  };
  const { busy, state } = snapshot;
  const roleKey = roster?.role === 'owner' ? 'profile.roleOwner' : roster?.role === 'admin' ? 'profile.roleAdmin' : null;
  const errorKey = state === 'forbidden' ? 'profile.errForbidden' : state === 'network' ? 'profile.errNetwork' : state === 'generic' ? 'profile.errGeneric' : null;
  const showButton = !isSelf && state !== 'self' && state !== 'unavailable';

  return (
    <Modal transparent visible animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessible={false} importantForAccessibility="no" />
        <View testID="profile-sheet" style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16), maxHeight: '90%' }]} accessibilityViewIsModal onAccessibilityEscape={close}>
          <View style={styles.handle} accessible={false} />
          <Pressable style={({ pressed }) => [styles.close, pressed && styles.pressed]} onPress={close} accessibilityRole="button" accessibilityLabel={t('profile.close')}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
          <ScrollView contentContainerStyle={styles.content} bounces={false}>
            <View style={styles.avatar} accessible={false}>
              {uri && failedUri !== uri ? (
                <Image source={{ uri }} style={styles.photo} onError={() => setFailedUri(uri)} accessible={false} />
              ) : (
                <Text style={styles.initial}>{(user.display_name || user.username || '?').slice(0, 1).toUpperCase()}</Text>
              )}
            </View>
            <Text ref={nameRef} style={styles.name} accessibilityRole="header">{user.display_name || user.username}</Text>
            <Text style={styles.username}>@{user.username}</Text>
            {(roster?.presence !== undefined || roleKey !== null) && (
              <View style={styles.meta}>
                {roster?.presence !== undefined && (
                  <View testID="profile-presence" style={styles.presence}>
                    <View style={[styles.dot, roster.presence === 'online' && styles.online]} accessible={false} />
                    <Text style={styles.metaText}>{t(roster.presence === 'online' ? 'profile.online' : 'profile.offline')}</Text>
                  </View>
                )}
                {roleKey && <View style={styles.role}><Text style={styles.roleText}>{t(roleKey)}</Text></View>}
              </View>
            )}
            <View style={styles.actions}>
              {(isSelf || state === 'self') && <Text style={styles.note}>{t('profile.self')}</Text>}
              {state === 'unavailable' && <Text testID="profile-unavailable" accessibilityRole="alert" style={styles.note}>{t('profile.unavailable')}</Text>}
              {errorKey && <Text testID="profile-dm-error" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{t(errorKey)}</Text>}
              {showButton && (
                <Pressable ref={dmButton} testID="profile-dm-button" accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => void flowRef.current?.start()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                  {busy && <ActivityIndicator color={theme.colors.background} />}
                  <Text style={styles.buttonText}>{t(busy ? 'profile.dmOpening' : 'profile.dm')}</Text>
                </Pressable>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: theme.colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: theme.colors.border, paddingTop: 10 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.textMuted, marginBottom: 24 },
  close: { position: 'absolute', top: 12, right: 12, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  closeText: { color: theme.colors.text, fontSize: 20 },
  content: { alignItems: 'center', paddingHorizontal: 24, paddingBottom: 8 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 14 },
  photo: { width: 64, height: 64, borderRadius: 32 },
  initial: { color: theme.colors.primary, fontSize: 26, fontWeight: '700' },
  name: { color: theme.colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  username: { color: '#aab5c8', fontSize: 15, textAlign: 'center', marginTop: 4 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 14 },
  presence: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#aab5c8' },
  online: { backgroundColor: '#4ade80' },
  metaText: { color: '#aab5c8', fontSize: 13 },
  role: { backgroundColor: theme.colors.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 10, paddingVertical: 4 },
  roleText: { color: theme.colors.text, fontSize: 12, fontWeight: '600' },
  actions: { alignSelf: 'stretch', gap: 12, marginTop: 24 },
  note: { color: '#aab5c8', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  error: { color: '#fca5a5', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  button: { minHeight: 50, borderRadius: 14, backgroundColor: theme.colors.primary, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  buttonText: { color: theme.colors.background, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  pressed: { opacity: 0.8 },
});
