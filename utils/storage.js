// utils/storage.js
import fs from 'node:fs';
import fetch from 'node-fetch';
import { DiscordRequest } from './discord.js';

const DB_FILE = new URL('../data.json', import.meta.url);
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

export async function flushStore(store) {
  if (!USE_SB) {
    fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
    return;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
    const target = store || latest;
    if (target) {
      const snapshot = JSON.parse(JSON.stringify(target));
      chain = chain
        .then(async () => {
          const res = await fetch(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
            method: 'POST',
            headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ key: 'store', value: snapshot }),
          });
          if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        })
        .catch((e) => console.error('Supabase flush failed:', e.message));
    }
  }
  return chain;
}

export async function cleanupExpiredDrafts(store, saveStoreFn) {
  const EXPIRATION_MS = 10 * 60 * 1000;
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