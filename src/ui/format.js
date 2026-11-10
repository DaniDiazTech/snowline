/**
 * Small formatting helpers shared by the UI views (pure, no DOM).
 */

/** 94523 → "1:34.52" (m:ss.cc). Negative / non-finite → "—". */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const cs = Math.floor(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Gap to the winner: 1234 → "+1.23", 75000 → "+1:15.00". */
export function formatGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `+${(Math.floor(ms / 10) / 100).toFixed(2)}`;
  return `+${formatTime(ms)}`;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n) {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

/** Ordinal suffix only ("st", "nd"…). */
export function ordinalSuffix(n) {
  return ordinal(n).replace(/^\d+/, '');
}

/** Epoch ms → "just now", "5 min ago", "3 d ago", or a short date. */
export function relativeTime(at, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "https://a.b/c?room=X" → "a.b/c?room=X" (for display only). */
export function prettyUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '');
}
