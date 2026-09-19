import { t } from '@banana-chat/shared';
import { useSession } from '../state/session';

/** FR-I18N-001: chat follows the signed-in member’s language. */
export function useChatText() {
  const locale = useSession(s => s.me?.locale === 'th' ? 'th' : 'en');
  return { locale, text: (key: string) => t(key, locale) };
}
