import type { CSSProperties } from 'react';

/** Presentation primitives adapted from the sibling banana-chat design. */
export function Banana({ size = 30 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M34 9c2 15-7 27-24 22 5 10 22 13 29 0 4-7 2-13-2-17l-3-5Z" fill="currentColor" /><path d="m32 9 4-2 3 6-4 2" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" /></svg>;
}
const paths = {
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5a9.5 9.5 0 1 1 19-1Z" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  sparkle: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="m20 2 0 4M18 4h4" /></>,
  logout: <><path d="M9 4H4v16h5M13 7l5 5-5 5M8 12h12" /></>,
  paperclip: <path d="m9 16 8-8a3 3 0 0 0-4-4L4 13a5 5 0 0 0 7 7l9-9M8 13l7-7" />,
  send: <><path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14" /></>,
  files: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  bell: <><path d="M5 9a7 7 0 0 1 14 0v6l2 3H3l2-3V9ZM10 21h4" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
};
export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Avatar({ name, className = '' }: { name: string; className?: string }) {
  const color = [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6;
  return <span className={`bc-avatar ${className}`} style={{ '--avatar-bg': ['#dce8d9','#eddfd1','#e4e0ee','#f7e8b9','#dce8ed','#efdcdd'][color], '--avatar-ink': ['#537448','#946f4f','#847292','#9b873e','#618a99','#a26c71'][color] } as CSSProperties} aria-hidden="true">{name.split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase()}</span>;
}
