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
  if (!token) throw new Error('Token was unavailable to the client.');

  const existingSession = activeClients.get(userId);

  // If a session already exists, verify it and reuse it to prevent race conditions
  if (existingSession) {
    // If the token changed, we must destroy and recreate
    if (existingSession.token !== token) {
      try {
        await existingSession.client.destroy();
      } catch (e) {}
      activeClients.delete(userId);
    } else if (existingSession.client.isReady && existingSession.client.isReady()) {
      return existingSession.client; // Reuse existing healthy client session!
    } else {
      // If client dropped connection, clean it up before re-logging in
      try {
        await existingSession.client.destroy();
      } catch (e) {}
      activeClients.delete(userId);
    }
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

  try {
    await client.login(token);
    activeClients.set(userId, { client, token });
    return client;
  } catch (err) {
    activeClients.delete(userId);
    throw new Error(`Failed to login user token: ${err.message}`);
  }
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