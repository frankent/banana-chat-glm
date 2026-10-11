import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { UserStub } from '@banana-chat/shared';
import { theme } from '../lib/theme';

/** FR-PROF-009 — decorative avatar; the enclosing trigger supplies its label. */
export function SenderAvatar({ user }: { user: UserStub }) {
  const uri = user.avatar?.sm;
  const [failedUri, setFailedUri] = useState<string>();
  return (
    <View style={styles.avatar} accessible={false}>
      {uri && failedUri !== uri ? (
        <Image source={{ uri }} style={styles.image} onError={() => setFailedUri(uri)} accessible={false} />
      ) : (
        <Text style={styles.initial}>{(user.display_name || user.username || '?').slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: 28, height: 28, borderRadius: 14 },
  initial: { color: theme.colors.primary, fontSize: 12, fontWeight: '700' },
});
