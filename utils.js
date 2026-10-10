import fs from 'node:fs';

const API = 'https://discord.com/api/v10';

/** Small wrapper around the Discord HTTP API (same idea as the tutorial's DiscordRequest). */
export async function DiscordRequest(endpoint, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Discord ${res.status} ${method} ${endpoint}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- tiny JSON "database" (swap for a real DB in production) ---------- */
const DB_FILE = new URL('./data.json', import.meta.url);

export function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { users: {}, drafts: {}, configs: {} };
  }
}

export function saveStore(store) {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

/* ---------- helpers ---------- */
export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'config';

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_HISTORY = 1n << 16n;

/**
 * Channel is hidden from everyone except the user and the bot.
 * The user can see + read + press buttons, but can't type (they only use the UI).
 */
export function privateOverwrites(guildId, userId) {
  return [
    // @everyone role id == guild id
    { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
    { id: userId, type: 1, allow: String(VIEW_CHANNEL | READ_HISTORY), deny: String(SEND_MESSAGES) },
    {
      id: process.env.APP_ID, // a bot user's id equals its application id
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY),
      deny: '0',
    },
  ];
}
