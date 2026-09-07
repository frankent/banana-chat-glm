import th from '../i18n/th.json' with { type: 'json' };
import en from '../i18n/en.json' with { type: 'json' };

/**
 * FR-I18N-001 — shared th/en catalogs used by web and mobile. Server errors
 * arrive as codes; clients map them via `t()` with the user's locale.
 */
export type Locale = 'th' | 'en';

const CATALOGS: Record<Locale, Record<string, string>> = { th, en };

export function t(key: string, locale: Locale = 'th'): string {
  return CATALOGS[locale][key] ?? CATALOGS.th[key] ?? key;
}

export function createTranslator(locale: Locale): (key: string) => string {
  return (key: string) => t(key, locale);
}
