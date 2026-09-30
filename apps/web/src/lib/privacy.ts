import { useSyncExternalStore } from 'react';
import { PrivacyLock, PRIVACY_MODE_STORAGE_KEY } from '@banana-chat/chat-core';

function readMirror() {
  try { return localStorage.getItem(PRIVACY_MODE_STORAGE_KEY); } catch { return null; }
}
function hasSession() {
  try { return localStorage.getItem('orgchat.refresh') !== null; } catch { return false; }
}
// FR-NOTI-009: constructed before React's first render, never after a content paint.
export const privacyLock = new PrivacyLock({ mirror: readMirror(), hasSession: hasSession() });
let generation = 0;
let snapshot = { enabled: privacyLock.enabled, covered: privacyLock.covered, generation };
const listeners = new Set<() => void>();
function publish() {
  snapshot = { enabled: privacyLock.enabled, covered: privacyLock.covered, generation };
  document.documentElement.classList.toggle('bc-privacy-covered', snapshot.covered);
  if (snapshot.enabled || snapshot.covered) document.title = 'Banana Chat';
  listeners.forEach(listener => listener());
}
export function usePrivacy() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
export function setPrivacyMode(enabled: boolean, lockOnEnable = true) {
  // FR-NOTI-009: no read started before an enable may undo that transition.
  if (enabled && !privacyLock.enabled) settingsVersion++;
  privacyLock.setSession(hasSession());
  privacyLock.setEnabled(enabled, lockOnEnable);
  try {
    if (enabled) localStorage.setItem(PRIVACY_MODE_STORAGE_KEY, '1');
    else localStorage.removeItem(PRIVACY_MODE_STORAGE_KEY);
  } catch { /* The in-memory guard remains active if storage is unavailable. */ }
  publish();
}
export function clearPrivacySession() {
  generation++;
  privacyLock.logout();
  try { localStorage.removeItem(PRIVACY_MODE_STORAGE_KEY); } catch { /* unavailable */ }
  publish();
}
export function unlockPrivacy(expectedGeneration: number) {
  if (expectedGeneration !== generation) return;
  privacyLock.unlock();
  publish();
}
export function suspendPrivacyLock(ms: number, event: { isTrusted: boolean }) {
  // FR-NOTI-009: only handlers for app-owned pickers may grant this single-use guard.
  if (!event.isTrusted || !navigator.userActivation?.isActive) return;
  if (privacyLock.suspend(ms, performance.now(), true)) {
    window.setTimeout(() => { privacyLock.expire(performance.now()); publish(); }, Math.min(60_000, Math.max(0, ms)) + 1);
  }
}
export function installPrivacyEvents() {
  const visibility = () => {
    if (document.visibilityState === 'hidden') {
      generation++;
      privacyLock.hide(performance.now());
    } else privacyLock.show(performance.now());
    publish(); // CSS cover is synchronous, before the browser captures a snapshot.
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) generation++;
    privacyLock.pageShow(event.persisted, performance.now()); publish();
  };
  const pageHide = () => { generation++; privacyLock.hide(performance.now()); publish(); };
  const picker = (event: MouseEvent) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') suspendPrivacyLock(60_000, event);
  };
  const pickerDone = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
      privacyLock.cancelSuspension(); publish();
    }
  };
  const storage = (event: StorageEvent) => {
    if (event.key === PRIVACY_MODE_STORAGE_KEY && event.newValue === '1') setPrivacyMode(true);
    // A removed mirror is not sufficient authority to unlock another tab. /me is.
  };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('click', picker, true);
  document.addEventListener('change', pickerDone, true);
  document.addEventListener('cancel', pickerDone, true);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('storage', storage);
  publish();
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('click', picker, true);
    document.removeEventListener('change', pickerDone, true);
    document.removeEventListener('cancel', pickerDone, true);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('pagehide', pageHide);
    window.removeEventListener('storage', storage);
  };
}

// Ignore older GETs while an optimistic PUT or a different session is in flight.
let settingsVersion = 0;
let saving = false;
let activeSave: number | null = null;
export function privacySettingsVersion() { return settingsVersion; }
export function applyPrivacySettings(enabled: boolean, version: number, lockOnEnable = true) {
  if (version !== settingsVersion || saving) return;
  setPrivacyMode(enabled, lockOnEnable);
}
export function beginPrivacySave(enabled: boolean) {
  saving = true;
  settingsVersion++;
  setPrivacyMode(enabled, false);
  activeSave = settingsVersion;
  return settingsVersion;
}
export function finishPrivacySave(enabled: boolean, version: number) {
  if (version !== activeSave) return;
  activeSave = null;
  saving = false;
  // A cross-tab enable supersedes the write, but must not leave reads blocked.
  if (version !== settingsVersion) return;
  settingsVersion++;
  setPrivacyMode(enabled, false);
}
export function resetPrivacySettingsRequests() { settingsVersion++; saving = false; activeSave = null; }
