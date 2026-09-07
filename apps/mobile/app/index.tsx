import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useSession } from '../src/auth/session';
import { theme } from '../src/lib/theme';

export default function Index() {
  const status = useSession((s) => s.status);
  const mustChange = useSession((s) => s.me?.must_change_password === true);
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated' && mustChange) {
      router.replace('/change-password');
    }
  }, [status, mustChange, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (status === 'authenticated') {
    return <Redirect href="/rooms" />;
  }
  return <Redirect href="/login" />;
}
