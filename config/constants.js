// config/constants.js
export const COLOR = {
  blurple: 0x5865f2,
  green: 0x57f287,
  amber: 0xfee75c,
  red: 0xed4245,
  dark: 0x2f3136,
  grey: 0x4f545c,
};

export const MAX_OPEN_SETUPS = 3;
export const AUTO_SYNC_INTERVAL_MS = 7 * 60 * 1000;
export const TELEMETRY_EDIT_INTERVAL_MS = 1300;
export const DEFAULT_STAGGER_SEC = 20;

export function getMaxConfigs(userId, store) {
  const ADMIN_ID = process.env.ADMIN_ID;
  if (userId === ADMIN_ID) return Infinity;

  const access = store.access?.[userId];
  if (!access) return 5;

  if (access.expiresAt === 'permanent') return Infinity;

  const label = access.durationLabel || '';
  if (label.includes('Permanent') || label.includes('Lifetime')) return Infinity;
  if (label.includes('1 Month')) return 50;
  if (label.includes('7 Days') || label.includes('1 Week')) return 25;
  if (label.includes('3 Days')) return 10;
  if (label.includes('Free Trial') || label.includes('24 Hours') || label.includes('Days (Free Trial)')) return 5;

  return 5;
}