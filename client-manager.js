// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const activeClients = new Map();
const BASE_PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;

// Dynamically generate a sticky session proxy URL per user
function getUserProxy(userId) {
  if (!BASE_PROXY_URL) return undefined;
  try {
    const url = new URL(BASE_PROXY_URL);
    // proxy.market and similar providers use "-session-[string]" attached to the username
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
  // Return existing active client if it exists to prevent duplicate connections
  if (activeClients.has(userId)) {
    const existingClient = activeClients.get(userId);
    if (existingClient.isReady()) return existingClient;
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

  // Prevent individual WebSocket drops from crashing the main Node process
  client.on('error', (err) => console.error(`[User ${userId}] WebSocket Error:`, err.message));

  await client.login(token);
  activeClients.set(userId, client);
  return client;
}

export function stopUserClient(userId) {
  const client = activeClients.get(userId);
  if (client) {
    client.destroy();
    activeClients.delete(userId);
  }
}