// services/runner.js
import { COLOR } from '../config/constants.js';
import { decryptCredential } from '../utils/crypto.js';
import { sendDM } from '../utils/discord.js';
import { previewSpintax } from '../utils/validators.js';
import { getUserClient } from '../client-manager.js';
import { purgeExpiredUser, runCleanupExpiredAccess } from './access-cleanup.js';

export { recoverStaggeredRollouts } from './staggered.js';

const timers = new Map();

export function stopRunner(id) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export function startRunner(id, immediate = true, store, saveStore, refreshCardCallback, initialDelaySec = null) {
  stopRunner(id);
  const c = store.configs[id];
  if (!c) return;

  const scheduleNext = (baseDelaySeconds, applyJitter = true) => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return;

    const jitterFactor = applyJitter ? 1 + (Math.random() * 0.3 - 0.15) : 1;
    const delayMs = Math.max(1000, Math.floor(baseDelaySeconds * 1000 * jitterFactor));
    timers.set(id, setTimeout(tick, delayMs));
  };

  const tick = async () => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return stopRunner(id);

    const ADMIN_ID = process.env.ADMIN_ID;
    const access = store.access[currentConfig.userId];
    const now = Date.now();

    if (currentConfig.userId !== ADMIN_ID) {
      if (access && access.expiresAt !== 'permanent' && now > access.expiresAt) {
        await purgeExpiredUser(
          currentConfig.userId,
          access,
          currentConfig.guildId,
          store,
          saveStore,
          stopRunner,
          'All your account token data, posting configurations, and controller channels have been cleared from the database.'
        );
        return;
      } else if (!access) {
        currentConfig.running = false;
        currentConfig.startedAt = null;
        currentConfig.lastError = '⚠️ Access Denied: Security clearance not found.';
        saveStore(store);
        if (refreshCardCallback) refreshCardCallback(id, { force: true }).catch(() => {});
        return stopRunner(id);
      }
    }

    const userCreds = store.credentials[currentConfig.userId];
    const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
    const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

    if (!activeToken) {
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError =
        'Authentication Failure: No valid session token found. Execute `/add-token register` to re-authenticate.';
      saveStore(store);
      if (refreshCardCallback) refreshCardCallback(id, { force: true }).catch(() => {});
      return stopRunner(id);
    }

    try {
      const client = await getUserClient(currentConfig.userId, activeToken);

      const channel = await client.channels.fetch(currentConfig.channelId);
      if (!channel) throw new Error('Target channel inaccessible.');

      const payload = previewSpintax(currentConfig.text);

      await channel.sendTyping().catch(() => {});
      const typingDuration = Math.min(Math.max(payload.length * 150, 1500), 6000);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      await channel.send({ content: payload, allowed_mentions: { parse: [] } });

      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      currentConfig.lastError = null;

      saveStore(store);
      if (refreshCardCallback) {
        refreshCardCallback(id, { force: false }).catch(() => {});
      }

      scheduleNext(currentConfig.delay);
    } catch (err) {
      if (err.status === 429) {
        console.warn(`Pipeline ${id}: Rate limited (429). Applying backoff penalty...`);
        scheduleNext(currentConfig.delay * 2);
        return;
      }
      if (!err.status || err.status >= 500) {
        console.warn(`Pipeline ${id}: Transient network delay skipped dispatch (${err.message})`);
        scheduleNext(currentConfig.delay);
        return;
      }

      console.error(`Pipeline ${id} dispatch error:`, err.message);

      currentConfig.failed = (currentConfig.failed ?? 0) + 1;
      currentConfig.lastError = `Dispatch Failed: ${err.message}`;
      saveStore(store);

      if (refreshCardCallback) refreshCardCallback(id, { force: true }).catch(() => {});

      await sendDM(currentConfig.userId, {
        embeds: [{
          color: COLOR.red,
          title: '⚠️ AUTOMATEX DISPATCH NOTIFICATION',
          description:
            `Your pipeline **\`${currentConfig.name}\`** encountered an issue and skipped a message dispatch to <#${currentConfig.channelId}>.\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `**Reason:** \`${err.message}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*Note:* Your pipeline is **still running** and will automatically attempt to send again on the next scheduled cycle.`,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});

      scheduleNext(currentConfig.delay);
    }
  };

  if (immediate) {
    tick();
  } else if (initialDelaySec != null) {
    scheduleNext(initialDelaySec, false);
  } else {
    scheduleNext(c.delay);
  }
}

export function stopAllRunnersForUser(guildId, userId, store, saveStore) {
  const mine = Object.entries(store.configs).filter(
    ([, c]) => c.userId === userId && c.guildId === guildId && c.running
  );
  for (const [id, c] of mine) {
    stopRunner(id);
    c.running = false;
    c.startedAt = null;
  }
  if (mine.length) saveStore(store);
  return mine;
}

export const cleanupExpiredAccess = (store, saveStore) =>
  runCleanupExpiredAccess(store, saveStore, stopRunner);