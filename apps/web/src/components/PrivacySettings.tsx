import { useId, useRef, useState } from 'react';
import { privacyText } from '../lib/privacy-text';
import '../privacy.css';

type Props = { enabled: boolean; onChange: (enabled: boolean) => Promise<void>; locale: 'th' | 'en' };

/** FR-NOTI-008: parent owns optimistic updates and rolls back rejected writes. */
export function PrivacySettings({ enabled, onChange, locale }: Props) {
  const text = privacyText[locale];
  const id = useId();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try { await onChange(!enabled); }
    catch { setFailed(true); }
    finally { pending.current = false; setSaving(false); }
  };
  return (
    <section className="bc-privacy-settings" lang={locale} aria-labelledby={`${id}-title`}>
      <div className="bc-privacy-setting-row">
        <strong id={`${id}-title`}>{text.title}</strong>
        <button type="button" role="switch" aria-checked={enabled} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} disabled={saving} onClick={() => void toggle()} className="bc-privacy-switch" data-testid="privacy-mode-switch"><span /></button>
      </div>
      <p id={`${id}-description`}>{text.description}</p>
      {saving && <p role="status">{text.saving}</p>}
      {failed && <p className="bc-privacy-error" role="alert">{text.saveError}</p>}
    </section>
  );
}
