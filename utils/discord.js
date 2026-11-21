// utils/discord.js
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API = 'https://discord.com/api/v10';
const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

export async function DiscordRequest(endpoint, { method = 'GET', body, token } = {}, retries = 3) {
  const isUserToken = token && !token.startsWith('Bot ');
  const authHeader = token ? token : `Bot ${process.env.DISCORD_TOKEN}`;

  const headers = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };

  if (isUserToken) {
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9015 Chrome/120.0.6099.291 Electron/28.2.5 Safari/537.36';
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
    signal: controller.signal,
  };

  try {
    const res = await fetch(`${API}/${endpoint}`, fetchOptions);
    clearTimeout(timeout);

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

export const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

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
      deny: '0',
    });
  }

  return overwrites;
}