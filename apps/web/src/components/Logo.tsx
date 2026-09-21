import { useState } from 'react';
import { useAppConfig } from '../hooks/useAppConfig';
import { Banana } from './Visual';

/**
 * FR-ADM-015/DEC-082 — the admin-uploaded system logo, or the built-in
 * Banana mark. `size` is the rendered image's box; `fallbackSize` sizes the
 * Banana icon within the same slot, since the two don't carry the same
 * visual weight at equal pixel dimensions.
 */
export function Logo({ size, fallbackSize }: { size: number; fallbackSize?: number }) {
  const { data } = useAppConfig();
  const logoUrl = data?.logo_url ?? null;
  // Keyed by the URL itself so a newly uploaded logo (a new ?v=) always gets
  // a fresh `errored` — remounting beats an effect for "reset on prop change".
  return <LogoImage key={logoUrl ?? 'fallback'} logoUrl={logoUrl} size={size} fallbackSize={fallbackSize} />;
}

function LogoImage({ logoUrl, size, fallbackSize }: { logoUrl: string | null; size: number; fallbackSize?: number }) {
  const [errored, setErrored] = useState(false);

  if (logoUrl !== null && !errored) {
    return (
      <span className="bc-logo-mark has-logo" style={{ width: size, height: size }}>
        <img src={logoUrl} alt="" onError={() => setErrored(true)} />
      </span>
    );
  }

  return (
    <span className="bc-logo-mark" style={{ width: size, height: size }}>
      <Banana size={fallbackSize ?? size} />
    </span>
  );
}
