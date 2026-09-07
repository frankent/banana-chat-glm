import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { useSession } from '../src/auth/session';
import { isAppUpdateRequired } from '../src/update/gate';
import { setLocale } from '../src/lib/i18n';
import { theme } from '../src/lib/theme';
import { connectRealtime, disconnectRealtime } from '../src/realtime/echo';
import { ANDROID_CHANNELS, badgeNumber, parseDeepLink, shouldShowForegroundBanner } from '../src/push/routing';
import { getCurrentRoomId } from '../src/push/current-room';
import { endpoints } from '../src/lib/api';

/**
 * TASK-MOB-001/008 — root layout: primes SecureStore, bootstraps the session,
 * realtime Echo wiring, push channels + foreground banner rules + deep links,
 * and routes 426 APP_UPDATE_REQUIRED to the dead-end update screen
 * (TC-MOB-042).
 */
Notifications.setNotificationHandler({
  handleNotification: (notification) => {
    // TC-MOB-031 — banner only when the push is not for the open room
    const data = notification.request.content.data as Record<string, unknown> | undefined;
    const show = shouldShowForegroundBanner(data, getCurrentRoomId());
    return Promise.resolve({
      shouldShowBanner: show,
      shouldShowAlert: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: true,
    });
  },
});

export default function RootLayout() {
  const router = useRouter();
  const status = useSession((s) => s.status);
  const me = useSession((s) => s.me);
  const currentWorkspace = useSession((s) => s.currentWorkspace);

  useEffect(() => {
    void useSession.getState().bootstrap();
  }, []);

  useEffect(() => {
    if (me !== null) {
      setLocale(me.locale);
    }
  }, [me]);

  // realtime: connect on auth, disconnect on logout; room churn → refetch rooms
  useEffect(() => {
    if (status === 'authenticated') {
      connectRealtime(() => {
        void endpoints.myWorkspaces().then((workspaces) => {
          useSession.setState({ workspaces });
        }).catch(() => undefined);
      });
    } else {
      disconnectRealtime();
    }
    return () => disconnectRealtime();
  }, [status, currentWorkspace]);

  // Android notification channels (TC-MOB-034)
  useEffect(() => {
    if (Platform.OS === 'android') {
      void Notifications.getNotificationChannelsAsync().then(async (existing) => {
        const have = new Set(existing.map((c) => c.id));
        for (const ch of ANDROID_CHANNELS) {
          if (!have.has(ch.id)) {
            await Notifications.setNotificationChannelAsync(ch.id, {
              name: ch.name,
              importance: ch.importance === 'high' ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.DEFAULT,
            });
          }
        }
      });
    }
  }, []);

  // push tap → deep link (orgchat://room/{ws}/{id} | orgchat://ai/{id})
  useEffect(() => {
    const navigate = (url: string) => {
      const link = parseDeepLink(url);
      if (link === null) {
        return;
      }
      if (link.type === 'ai') {
        router.push(`/ai/${link.conversationId}`);
        return;
      }
      if (useSession.getState().currentWorkspace?.workspace.slug !== link.workspaceSlug) {
        useSession.getState().switchWorkspace(link.workspaceSlug);
      }
      router.push(`/room/${link.roomId}`);
    };
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const deepLink = response.notification.request.content.data?.['deep_link'];
      if (typeof deepLink === 'string') {
        navigate(deepLink);
      }
    });
    const linkingSub = Linking.addEventListener('url', ({ url }) => navigate(url));
    void Linking.getInitialURL().then((url) => {
      if (url != null) {
        navigate(url);
      }
    });
    return () => {
      sub.remove();
      linkingSub.remove();
    };
  }, [router]);

  // TC-MOB-033 — badge mirrors workspace unread on foreground
  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }
    const refresh = () => {
      void endpoints.myWorkspaces()
        .then((workspaces) => {
          useSession.setState({ workspaces });
          const total = workspaces.reduce((sum, w) => sum + w.total_unread, 0);
          void Notifications.setBadgeCountAsync(badgeNumber(total));
        })
        .catch(() => undefined);
    };
    refresh();
    const sub = Notifications.addNotificationReceivedListener(() => refresh());
    return () => sub.remove();
  }, [status]);

  useEffect(() => {
    // any screen can flag the gate via session errors — simplest global hook
    const handler = (error: unknown) => {
      if (isAppUpdateRequired(error)) {
        router.replace('/force-update');
      }
    };
    (globalThis as { __onApiError?: (e: unknown) => void }).__onApiError = handler;
    return () => {
      delete (globalThis as { __onApiError?: (e: unknown) => void }).__onApiError;
    };
  }, [router]);

  // leaving any room screen clears the suppression key (room/[id] owns the
  // setCurrentRoom lifecycle)

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="login" options={{ title: 'Banana Chat' }} />
        <Stack.Screen name="rooms" options={{ title: '' }} />
        <Stack.Screen name="room/[id]" options={{ title: '' }} />
        <Stack.Screen name="ai/index" options={{ title: 'AI' }} />
        <Stack.Screen name="ai/[id]" options={{ title: '' }} />
        <Stack.Screen name="ai/memory" options={{ title: '' }} />
        <Stack.Screen name="settings/index" options={{ title: '' }} />
        <Stack.Screen name="settings/notifications" options={{ title: '' }} />
        <Stack.Screen name="force-update" options={{ headerShown: false, gestureEnabled: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
