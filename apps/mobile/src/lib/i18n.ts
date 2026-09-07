import { createTranslator, type Locale } from '@banana-chat/shared';

/** FR-I18N-001 — locale follows the user profile (default th). */
let current: Locale = 'th';

export function setLocale(locale: string | undefined | null): void {
  current = locale === 'en' ? 'en' : 'th';
}

export function getLocale(): Locale {
  return current;
}

export function tr(): (key: string) => string {
  return createTranslator(getLocale());
}
