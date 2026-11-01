import fs from 'node:fs';
import crypto from 'node:crypto';

const API = 'https://discord.com/api/v10';

/** Small wrapper around the Discord HTTP API (same idea as the tutorial's DiscordRequest). */
export async function DiscordRequest(endpoint, { method = 'GET', body, token } = {}) {
  // If a specific token is provided, use it; otherwise use the main bot token
  const authHeader = token ? `Bot ${token}` : `Bot ${process.env.DISCORD_TOKEN}`;
  
  const res = await fetch(`${API}/${endpoint}`, {
    method,
    headers: {
      Authorization: authHeader,
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

/* ---------- secure encryption helpers for research credentials ---------- */
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || crypto.randomBytes(32).toString('hex');

function getEncryptionKey() {
  return crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
}

export function encryptCredential(plainText) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decryptCredential(cipherText) {
  try {
    const [ivHex, tagHex, encryptedHex] = cipherText.split(':');
    if (!ivHex || !tagHex || !encryptedHex) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Credential decryption failed:', err.message);
    return null;
  }
}

export function redactToken(token) {
  if (!token || token.length < 10) return '[REDACTED]';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/* ---------- storage ----------
 * If SUPABASE_URL + SUPABASE_KEY are set -> everything is stored as one JSON row in Supabase
 * Otherwise -> falls back to a local data.json file.
 */
const DB_FILE = new URL('./data.json', import.meta.url);
const EMPTY = () => ({ users: {}, drafts: {}, configs: {}, botIntegrations: {}, credentials: {} });
const SB_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY;
const USE_SB = Boolean(SB_URL && SB_KEY);

const sbHeaders = () => ({
  apikey: SB_KEY,
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
 */
export function privateOverwrites(guildId, userId) {
  return [
    { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
    { id: userId, type: 1, allow: String(VIEW_CHANNEL | READ_HISTORY), deny: String(SEND_MESSAGES) },
    {
      id: process.env.APP_ID,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY),
      deny: '0',
    },
  ];
}

export async function createBotIntegration(userId, token, name) {
  try {
    const botInfo = await DiscordRequest(`users/@me`, { token });
    if (!botInfo) throw new Error('Failed to validate token');

    const botName = name || botInfo.username;
    const botId = botInfo.id;

    return {
      id: botId,
      userId,
      token,
      username: botName,
      createdAt: Date.now(),
    };
  } catch (err) {
    throw new Error(`Invalid bot token or API error: ${err.message}`);
  }
}