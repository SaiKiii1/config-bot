// utils/validators.js
import { getUserClient } from '../client-manager.js';
import { decryptCredential } from './crypto.js';

export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'config';

export function previewSpintax(text) {
  if (!text || typeof text !== 'string') return text;
  let resolved = text;
  const hasSpintax = /\{([^{}|]+(?:\|[^{}|]+)+)\}/;
  let passes = 0;
  while (hasSpintax.test(resolved) && passes < 10) {
    resolved = resolved.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, group) => {
      const choices = group.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
    passes++;
  }
  return resolved;
}

export async function validate(field, raw, guildId, userId, store) {
  if (field === 'name') return raw ? { value: raw.slice(0, 50) } : { error: 'Name cannot be blank.' };

  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'Invalid Snowflake ID format.' };
    try {
      const userCreds = store.credentials[userId];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;
      if (!activeToken) return { error: 'Authentication missing. Run `/add-token register`.' };

      const client = await getUserClient(userId, activeToken.trim());
      const ch = await client.channels.fetch(raw);

      if (!ch || !['GUILD_TEXT', 'GUILD_NEWS'].includes(ch.type)) return { error: 'Must be a text channel.' };
    } catch (err) {
      console.error('Channel validation failed:', err.message);
      if (err.code === 10003) return { error: 'Channel does not exist or account lacks access.' };
      if (err.message.includes('401')) return { error: 'Token is invalid or session flagged by Discord.' };
      return { error: `Validation failed: ${err.message.slice(0, 80)}` };
    }
    return { value: raw };
  }

  if (field === 'text') return raw ? { value: raw } : { error: 'Payload body cannot be empty.' };
  return { error: 'Unknown field.' };
}

export function parseDelay(v) {
  const [h, m, s] = ['hours', 'minutes', 'seconds'].map((k) => Number((v[k] ?? '').trim() || 0));
  const total = h * 3600 + m * 60 + s;
  if (total < 5 || total > 86400) return { error: 'Interval out of bounds (5s to 24h).' };
  return { value: total };
}