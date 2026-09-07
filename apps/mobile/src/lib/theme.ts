export const theme = {
  colors: {
    primary: '#facc15',
    background: '#0b1220',
    surface: '#141d2f',
    surfaceAlt: '#1c2740',
    text: '#e7ecf5',
    textMuted: '#8a94a8',
    border: '#26324d',
    danger: '#ef4444',
    pending: '#f59e0b',
  },
  radius: 12,
};

export function formatTime(iso: string | null, locale: string): string {
  if (iso === null) {
    return '';
  }
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale === 'th' ? 'th-TH' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  return time;
}
