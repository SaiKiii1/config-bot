// services/runner.js
import { DiscordRequest, decryptCredential } from '../utils.js';

const timers = new Map();

export function stopRunner(id, store) {
  const handle = timers.get(id);
  if (handle) {
    clearInterval(handle);
    timers.delete(id);
  }
}

export function startRunner(id, immediate = true, store, saveStore, refreshCardCallback) {
  stopRunner(id, store);
  const c = store.configs[id];
  if (!c) return;

  const userCreds = store.credentials[c.userId];
  const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
  const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

  const tick = async () => {
    const currentConfig = store.configs[id];
    if (!currentConfig) return stopRunner(id, store);

    // AUTOMATIC EXPIRY KILL SWITCH
    const ADMIN_ID = process.env.ADMIN_ID;
    const access = store.access[currentConfig.userId];
    const now = Date.now();
    
    if (currentConfig.userId !== ADMIN_ID && (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt))) {
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = '⚠️ Access Expired: Security clearance time limit reached.';
      saveStore(store);
      if (refreshCardCallback) refreshCardCallback(id).catch(() => {});
      return stopRunner(id, store);
    }

    if (!activeToken) {
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = 'Authentication Failure: No valid session token found. Execute `/add-token register` to re-authenticate.';
      saveStore(store);
      if (refreshCardCallback) refreshCardCallback(id).catch(() => {});
      return stopRunner(id, store);
    }

    try {
      await DiscordRequest(`channels/${currentConfig.channelId}/messages`, {
        method: 'POST',
        token: activeToken,
        body: { content: currentConfig.text, allowed_mentions: { parse: [] } },
      });
      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      if (currentConfig.sent % 10 === 0) saveStore(store);
    } catch (err) {
      if (err.status === 429) {
        console.warn(`Pipeline ${id}: Rate limited by Discord (429). Backing off this round...`);
        return;
      }
      if (!err.status || err.status >= 500) {
        console.warn(`Pipeline ${id}: transient network delay skipped dispatch (${err.message})`);
        return;
      }
      console.error(`Pipeline ${id} halted:`, err.message);
      stopRunner(id, store);
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = `Execution Terminated: API endpoint rejected payload dispatch (${err.message}).`;
      saveStore(store);
      if (refreshCardCallback) refreshCardCallback(id).catch(() => {});
    }
  };

  if (immediate) tick();
  timers.set(id, setInterval(tick, c.delay * 1000));
}

export function stopAllRunnersForUser(guildId, userId, store, saveStore, refreshCardCallback) {
  const mine = Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId && c.running);
  for (const [id, c] of mine) {
    stopRunner(id, store);
    c.running = false;
    c.startedAt = null;
  }
  if (mine.length) saveStore(store);
  return mine;
}