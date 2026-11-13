// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const activeClients = new Map(); // Stores { client, token } per user
const BASE_PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;

// Dynamically generate a sticky session proxy URL per user
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
  // If an active client exists, check if the token changed
  if (activeClients.has(userId)) {
    const session = activeClients.get(userId);
    
    // If the token matches and the client is ready, reuse it
    if (session.token === token && session.client.isReady()) {
      return session.client;
    }
    
    // Otherwise, destroy the old client because the token was updated or session dropped
    try {
      await session.client.destroy();
    } catch (e) {
      // Ignore destruction errors
    }
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

  // Prevent individual WebSocket drops from crashing the main Node process
  client.on('error', (err) => console.error(`[User ${userId}] WebSocket Error:`, err.message));

  await client.login(token);
  
  // Store both the client instance and its associated token
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