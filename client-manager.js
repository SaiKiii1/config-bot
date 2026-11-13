// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const activeClients = new Map();
const BASE_PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;

function getUserProxy(userId) {
  if (!BASE_PROXY_URL) return undefined;
  try {
    const url = new URL(BASE_PROXY_URL);
    if (url.username && !url.username.includes('-session-')) {
      url.username = `${url.username}-session-${userId}`;
    }
    return url.toString();
  } catch (e) {
    console.error('Invalid Proxy URL configuration:', e.message);
    return BASE_PROXY_URL;
  }
}

export async function getUserClient(userId, token) {
  // Always ensure a clean teardown if a client exists, forcing a fresh login with the current token
  if (activeClients.has(userId)) {
    const session = activeClients.get(userId);
    try {
      await session.client.destroy();
    } catch (e) {}
    activeClients.delete(userId);
  }

  const userProxy = getUserProxy(userId);

  const client = new Client({
    checkUpdate: false,
    rest: {
      agent: userProxy ? new ProxyAgent(userProxy) : undefined,
    },
    ws: {
      agent: userProxy ? new HttpsProxyAgent(userProxy) : undefined,
    }
  });

  client.on('error', (err) => console.error(`[User ${userId}] WebSocket Error:`, err.message));

  await client.login(token);
  activeClients.set(userId, { client, token });
  return client;
}

export function stopUserClient(userId) {
  const session = activeClients.get(userId);
  if (session) {
    try {
      session.client.destroy();
    } catch (e) {}
    activeClients.delete(userId);
  }
}