// utils.js
import fs from 'node:fs';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API = 'https://discord.com/api/v10';
const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

export async function DiscordRequest(endpoint, { method = 'GET', body, token } = {}, retries = 3) {
  const isUserToken = token && !token.startsWith('Bot ');
  const authHeader = token ? (token.startsWith('Bot ') ? token : token) : `Bot ${process.env.DISCORD_TOKEN}`;
  
  const headers = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };

  if (isUserToken) {
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9015 Chrome/120.0.6099.291 Electron/28.2.5 Safari/537.36';
    headers['X-Super-Properties'] = Buffer.from(
      JSON.stringify({
        os: 'Windows',
        browser: 'Discord Client',
        release_channel: 'stable',
        client_version: '1.0.9015',
        os_version: '10.0.19045',
        os_arch: 'x64',
        system_locale: 'en-US',
      })
    ).toString('base64');
    headers['Sec-Fetch-Dest'] = 'empty';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Site'] = 'same-origin';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const fetchOptions = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...(isUserToken && proxyAgent ? { agent: proxyAgent } : {}),
    signal: controller.signal
  };

  try {
    const res = await fetch(`${API}/${endpoint}`, fetchOptions);
    clearTimeout(timeout);
    
    // Automatically retry if Discord rate-limits the request
    if (res.status === 429 && retries > 0) {
      const data = await res.json().catch(() => ({}));
      const retryAfterMs = Math.ceil((data.retry_after || 1) * 1000);
      console.warn(`[API Rate Limit] ${endpoint} hit 429. Retrying in ${retryAfterMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      return DiscordRequest(endpoint, { method, body, token }, retries - 1);
    }

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Discord ${res.status} ${method} ${endpoint}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function sendDM(userId, messageBody) {
  try {
    const ch = await DiscordRequest('users/@me/channels', { method: 'POST', body: { recipient_id: userId } });
    await DiscordRequest(`channels/${ch.id}/messages`, { method: 'POST', body: messageBody });
  } catch (err) {
    console.error(`Failed to send DM to ${userId}:`, err.message);
  }
}

export async function manageRole(guildId, userId, roleId, action = 'PUT') {
  if (!roleId) return;
  try {
    await DiscordRequest(`guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: action });
  } catch (err) {
    console.error(`Failed to ${action} role ${roleId} for ${userId}:`, err.message);
  }
}

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

const DB_FILE = new URL('./data.json', import.meta.url);
const EMPTY = () => ({ users: {}, drafts: {}, configs: {}, botIntegrations: {}, credentials: {}, access: {} });
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
  if (timer) return;
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

export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'config';

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_HISTORY = 1n << 16n;

export function privateOverwrites(guildId, userId) {
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
    { id: userId, type: 1, allow: String(VIEW_CHANNEL | READ_HISTORY | SEND_MESSAGES), deny: '0' },
    {
      id: process.env.APP_ID,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY),
      deny: '0',
    },
  ];

  if (process.env.ADMIN_ID && process.env.ADMIN_ID !== userId) {
    overwrites.push({
      id: process.env.ADMIN_ID,
      type: 1,
      allow: String(VIEW_CHANNEL | READ_HISTORY | SEND_MESSAGES),
      deny: '0'
    });
  }

  return overwrites;
}

export async function ensureController(guildId, userIdOrUser, store, saveStoreFn) {
  const user = typeof userIdOrUser === 'string' ? { id: userIdOrUser, username: 'user' } : userIdOrUser;
  const key = `${guildId}:${user.id}`;

  if (store?.users?.[key]?.controllerChannelId) {
    const existingId = store.users[key].controllerChannelId;
    try {
      await DiscordRequest(`channels/${existingId}`, { method: 'GET' });
      return existingId;
    } catch (e) {
      // Channel missing or invalid; recreate below
    }
  }

  const ch = await DiscordRequest(`guilds/${guildId}/channels`, {
    method: 'POST',
    body: {
      name: `controller-${slug(user.username)}`,
      type: 0,
      parent_id: process.env.CONTROLLER_CATEGORY_ID,
      permission_overwrites: privateOverwrites(guildId, user.id),
    },
  });

  if (store) {
    store.users[key] = { ...(store.users[key] || {}), controllerChannelId: ch.id };
    if (saveStoreFn) saveStoreFn(store);
    else saveStore(store);
  }
  return ch.id;
}

// Sweeper function to clean up orphan setup channels on boot
export async function cleanupExpiredDrafts(store, saveStoreFn) {
  const EXPIRATION_MS = 10 * 60 * 1000; // 10 Minutes
  const now = Date.now();
  let cleaned = 0;

  for (const [channelId, draft] of Object.entries(store.drafts || {})) {
    if (now - draft.createdAt > EXPIRATION_MS) {
      console.log(`[SWEEPER] Purging expired setup channel: ${channelId}`);
      delete store.drafts[channelId];
      cleaned++;
      await DiscordRequest(`channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  if (cleaned > 0) {
    if (saveStoreFn) saveStoreFn(store);
    else saveStore(store);
  }
}