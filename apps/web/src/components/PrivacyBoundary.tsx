import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../state/session';
import { installPrivacyEvents, unlockPrivacy, usePrivacy } from '../lib/privacy';
import { PrivacyLockScreen } from './PrivacyLockScreen';
import '../privacy.css';

/** FR-NOTI-009 / FR-CALL-009: cover, never unmount, the router and ongoing calls. */
export function PrivacyBoundary({ children }: { children: ReactNode }) {
  const { covered, generation } = usePrivacy();
  const locale = useSession(s => s.me?.locale === 'en' ? 'en' : 'th');
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(installPrivacyEvents, []);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !covered) return;
    const previous = document.activeElement;
    element.showModal();
    // Portals (including existing modal dialogs) also belong behind the lock.
    const previousInert = new Map<HTMLElement, boolean>();
    const conceal = () => {
      for (const child of document.body.children) {
        if (child instanceof HTMLElement && child !== element && !previousInert.has(child)) {
          previousInert.set(child, child.inert); child.inert = true;
        }
      }
    };
    conceal();
    const observer = new MutationObserver(records => {
      conceal();
      // A queued app effect may open another native modal after this one. Keep
      // the lock last in the top layer so a hidden modal cannot steal its focus.
      const anotherModalOpened = records.some(record => {
        if (element.contains(record.target) || record.target === element) return false;
        if (record.type === 'attributes') return record.target instanceof HTMLDialogElement && record.target.open;
        return [...record.addedNodes].some(node => node instanceof HTMLElement &&
          (node.matches('dialog[open]') || node.querySelector('dialog[open]')));
      });
      if (anotherModalOpened) { element.close(); element.showModal(); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => {
      observer.disconnect();
      for (const [child, inert] of previousInert) child.inert = inert;
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [covered]);
  return <>
    <div className="bc-private-app" inert={covered} aria-hidden={covered || undefined}>{children}</div>
    {covered && createPortal(<dialog ref={dialog} className="bc-privacy-boundary" aria-label={locale === 'th' ? 'ปลดล็อกแชท' : 'Unlock chat'} onCancel={event => event.preventDefault()}>
      <PrivacyLockScreen key={generation} locale={locale} onUnlock={() => unlockPrivacy(generation)} onLogout={() => { void useSession.getState().logout(); }} />
    </dialog>, document.body)}
  </>;
}
