// services/runner.js
import { DiscordRequest, decryptCredential } from '../utils.js';

const timers = new Map();

export function stopRunner(id, store) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export function startRunner(id, immediate = true, store, saveStore, refreshCardCallback) {
  stopRunner(id, store);
  const c = store.configs[id];
  if (!c) return;

  // 1. ORGANIC JITTER ENGINE
  // Replaces the rigid interval with a randomized recursive timeout
  const scheduleNext = (baseDelaySeconds) => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return;

    // Introduce a random ±15% variance to the cadence to simulate human inconsistency
    const jitterFactor = 1 + (Math.random() * 0.3 - 0.15);
    const delayMs = Math.floor(baseDelaySeconds * 1000 * jitterFactor);
    
    timers.set(id, setTimeout(tick, delayMs));
  };

  const tick = async () => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return stopRunner(id, store);

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

    const userCreds = store.credentials[currentConfig.userId];
    const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
    const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

    if (!activeToken) {
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = 'Authentication Failure: No valid session token found. Execute `/add-token register` to re-authenticate.';
      saveStore(store);
      if (refreshCardCallback) refreshCardCallback(id).catch(() => {});
      return stopRunner(id, store);
    }

    try {
      // 2. INTELLIGENT PRE-FLIGHT CHECK
      // Check the channel's last message. If it matches our payload exactly, skip this cycle to avoid duplicate spam detection.
      try {
        const lastMsgs = await DiscordRequest(`channels/${currentConfig.channelId}/messages?limit=1`, { token: activeToken });
        if (lastMsgs && lastMsgs.length > 0 && lastMsgs[0].content === currentConfig.text) {
          console.warn(`Pipeline ${id}: Pre-flight check detected identical recent payload. Delaying to next cycle...`);
          scheduleNext(currentConfig.delay);
          return;
        }
      } catch (readErr) {
        // Ignore read permission errors, proceed with dispatch
      }

      // 3. TYPING INDICATOR SIMULATION
      // Triggers the "User is typing..." UI state in Discord before sending
      await DiscordRequest(`channels/${currentConfig.channelId}/typing`, { method: 'POST', token: activeToken }).catch(() => {});

      // 4. HUMANIZED TYPING DELAY
      // Calculates sleep duration based on character count (~150ms per character, between 1.5 and 6 seconds)
      const typingDuration = Math.min(Math.max(currentConfig.text.length * 150, 1500), 6000);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      // 5. PAYLOAD DISPATCH
      await DiscordRequest(`channels/${currentConfig.channelId}/messages`, {
        method: 'POST',
        token: activeToken,
        body: { content: currentConfig.text, allowed_mentions: { parse: [] } },
      });
      
      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      if (currentConfig.sent % 10 === 0) saveStore(store);

      scheduleNext(currentConfig.delay);

    } catch (err) {
      if (err.status === 429) {
        console.warn(`Pipeline ${id}: Rate limited (429). Applying backoff penalty...`);
        scheduleNext(currentConfig.delay * 2); // Exponential backoff penalty
        return;
      }
      if (!err.status || err.status >= 500) {
        console.warn(`Pipeline ${id}: Transient network delay skipped dispatch (${err.message})`);
        scheduleNext(currentConfig.delay);
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

  if (immediate) {
    tick();
  } else {
    scheduleNext(c.delay);
  }
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