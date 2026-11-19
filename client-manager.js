// client-manager.js
import { Client, Options } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const activeClients = new Map();
const pendingLogins = new Map();
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

  // Reuse an in-flight login if multiple configs for the same user wake up together
  const inflight = pendingLogins.get(userId);
  if (inflight && inflight.token === token) {
    return inflight.promise;
  }

  const userProxy = getUserProxy(userId);

  const clientOptions = {
    checkUpdate: false,
    rest: {
      agent: userProxy ? new ProxyAgent(userProxy) : undefined,
    },
    ws: {
      agent: userProxy ? new HttpsProxyAgent(userProxy) : undefined,
    },
  };

  // Prevent selfbot from caching messages/members/presences across all joined guilds
  if (Options?.cacheWithLimits) {
    clientOptions.makeCache = Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      GuildMemberManager: 5,
      UserManager: 10,
      PresenceManager: 0,
      ReactionManager: 0,
      ThreadManager: 0,
    });
  }

  if (Options?.DefaultSweeperSettings) {
    clientOptions.sweepers = {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 60 },
    };
  }

  const client = new Client(clientOptions);

  client.on('error', (err) => console.error(`[User ${userId}] WebSocket Error:`, err.message));

  const loginPromise = (async () => {
    try {
      await client.login(token);

      // Guard against stopUserClient() or token replacement happening mid-login
      if (pendingLogins.get(userId)?.promise !== loginPromise) {
        try {
          client.destroy();
        } catch (e) {}
        return activeClients.get(userId)?.client ?? client;
      }

      activeClients.set(userId, { client, token });
      return client;
    } catch (err) {
      activeClients.delete(userId);
      try {
        client.destroy();
      } catch (e) {}
      throw new Error(`Failed to login user token: ${err.message}`);
    } finally {
      if (pendingLogins.get(userId)?.promise === loginPromise) {
        pendingLogins.delete(userId);
      }
    }
  })();

  pendingLogins.set(userId, { token, promise: loginPromise });
  return loginPromise;
}

export function stopUserClient(userId) {
  pendingLogins.delete(userId);
  const session = activeClients.get(userId);
  if (session) {
    try {
      session.client.destroy();
    } catch (e) {}
    activeClients.delete(userId);
  }
}