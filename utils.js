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

/* ---------- storage ----------
 * If SUPABASE_URL + SUPABASE_KEY are set -> everything is stored as one JSON row in Supabase
 * (needed on Render's free plan, where the disk is wiped on every restart).
 * Otherwise -> falls back to a local data.json file (fine for running on your own PC).
 */
const DB_FILE = new URL('./data.json', import.meta.url);
const EMPTY = () => ({ users: {}, drafts: {}, configs: {} });
const SB_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY;
const USE_SB = Boolean(SB_URL && SB_KEY);

const sbHeaders = () => ({
  apikey: SB_KEY,
  // legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must not
  ...(SB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SB_KEY}` } : {}),
  'Content-Type': 'application/json',
});

export async function loadStore() {
  if (!USE_SB) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      return EMPTY();
    }
  }
  const res = await fetch(`${SB_URL}/rest/v1/kv?key=eq.store&select=value`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase load failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0]?.value ?? EMPTY();
}

let timer = null;
let latest = null;
let chain = Promise.resolve();

export function saveStore(store) {
  if (!USE_SB) {
    fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
    return;
  }
  latest = store;
  if (timer) return; // batch rapid changes into one write
  timer = setTimeout(() => {
    timer = null;
    const snapshot = JSON.parse(JSON.stringify(latest));
    chain = chain
      .then(async () => {
        const res = await fetch(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ key: 'store', value: snapshot }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      })
      .catch((e) => console.error('Supabase save failed:', e.message));
  }, 300);
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