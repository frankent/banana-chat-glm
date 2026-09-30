import { afterEach, expect, it, vi } from 'vitest';

async function browserPrivacy() {
  vi.resetModules();
  const storage = new Map([['orgchat.refresh', 'synthetic-session']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const document = Object.assign(new EventTarget(), {
    documentElement: { classList: { toggle() {} } }, title: '', visibilityState: 'visible',
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  // Load the browser bridge at runtime without adding web sources to the core TS project.
  const browserModule = '../../../apps/web/src/lib/privacy.ts';
  const privacy = await import(browserModule);
  privacy.installPrivacyEvents();
  const enableOtherTab = () => window.dispatchEvent(Object.assign(new Event('storage'), {
    key: 'bc.privacy_mode', newValue: '1',
  }));
  return { privacy, storage, enableOtherTab };
}
afterEach(() => vi.unstubAllGlobals());

it('TC-WEB-PRIVACY-021 stale false read cannot undo storage enable', async () => {
  const { privacy, storage, enableOtherTab } = await browserPrivacy();
  const old = privacy.privacySettingsVersion();
  enableOtherTab();
  privacy.applyPrivacySettings(false, old);
  expect(privacy.privacyLock.enabled).toBe(true);
  expect(privacy.privacyLock.locked).toBe(true);
  expect(storage.get('bc.privacy_mode')).toBe('1');
});

it('TC-WEB-PRIVACY-021 superseded save settles without blocking future reads', async () => {
  const { privacy, enableOtherTab } = await browserPrivacy();
  privacy.setPrivacyMode(true);
  const save = privacy.beginPrivacySave(false);
  enableOtherTab();
  privacy.finishPrivacySave(false, save);
  expect(privacy.privacyLock.locked).toBe(true);
  privacy.applyPrivacySettings(false, privacy.privacySettingsVersion());
  expect(privacy.privacyLock.enabled).toBe(false);
});

it('TC-WEB-PRIVACY-022 authoritative enable preserves typing but rejects older reads and locks on hide', async () => {
  const { privacy } = await browserPrivacy();
  const old = privacy.privacySettingsVersion();
  privacy.applyPrivacySettings(true, old, false);
  expect(privacy.privacyLock.enabled).toBe(true);
  expect(privacy.privacyLock.covered).toBe(false);
  privacy.applyPrivacySettings(false, old);
  expect(privacy.privacyLock.enabled).toBe(true);
  privacy.privacyLock.hide(1);
  privacy.privacyLock.show(2);
  expect(privacy.privacyLock.locked).toBe(true);
});
