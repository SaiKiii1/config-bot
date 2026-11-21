// services/runner.js
import { COLOR } from '../config/constants.js';
import { decryptCredential } from '../utils/crypto.js';
import { sendDM } from '../utils/discord.js';
import { getUserClient, stopUserClient } from '../client-manager.js';
import { purgeExpiredUser, runCleanupExpiredAccess } from './access-cleanup.js';
import {
  startStaggeredRollout,
  cancelStaggeredRollout,
  recoverStaggeredRollouts,
  clearStaggeredTimer,
} from './staggered.js';

export { startStaggeredRollout, cancelStaggeredRollout, recoverStaggeredRollouts };

const timers = new Map();
const userNextDispatchAt = new Map();
const USER_DISPATCH_MIN_GAP_MS = 2000;

function resolveSpintax(text) {
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

function isUnauthorizedError(err) {
  const status = err?.status || err?.httpStatus || err?.response?.status;
  const msg = String(err?.message || '').toLowerCase();
  return (
    status === 401 ||
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('token_invalid') ||
    msg.includes('incorrect login details') ||
    msg.includes('invalid token')
  );
}

function getFatalChannelOrPermReason(err) {
  const status = err?.status || err?.httpStatus || err?.response?.status;
  const code = Number(err?.code || err?.rawError?.code || 0);
  const msg = String(err?.message || '');

  if (code === 10003 || msg.includes('Unknown Channel')) {
    return '🚫 Channel Not Found (10003): Target channel was deleted or does not exist.';
  }
  if (code === 10004 || msg.includes('Unknown Guild')) {
    return '🚫 Server Inaccessible (10004): Account is no longer in the target server.';
  }
  if (
    code === 50001 ||
    code === 50013 ||
    status === 403 ||
    msg.includes('Missing Access') ||
    msg.includes('Missing Permissions')
  ) {
    return '🚫 Missing Permissions (50001/50013): Account lacks access or Send Messages permission in target channel.';
  }
  if (msg === 'Target channel inaccessible.') {
    return '🚫 Channel Inaccessible: Target channel could not be accessed.';
  }
  return null;
}

export function stopRunner(id) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export function startRunner(id, immediate = true, store, saveStore, refreshCardCallback, initialDelaySeconds = null) {
  stopRunner(id);
  const c = store.configs[id];
  if (!c) return;

  const scheduleNext = (baseDelaySeconds, addJitter = true) => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return;

    // Positive-only jitter (+4s to +8s)
    const jitterSeconds = addJitter ? Math.floor(Math.random() * 5) + 4 : 0;
    const delayMs = Math.max(0, baseDelaySeconds + jitterSeconds) * 1000;
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
        userNextDispatchAt.delete(currentConfig.userId);
        await purgeExpiredUser(
          currentConfig.userId,
          access,
          currentConfig.guildId,
          store,
          saveStore,
          stopRunner,
          'All your account token data, posting configurations, and controller channels have been cleared from the database.',
          clearStaggeredTimer
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

      // Enforce minimum 2s spacing between dispatches on the same user token
      const userId = currentConfig.userId;
      const nowMs = Date.now();
      const earliestDispatch = userNextDispatchAt.get(userId) || 0;
      const waitMs = Math.max(0, earliestDispatch - nowMs);
      userNextDispatchAt.set(userId, nowMs + waitMs + USER_DISPATCH_MIN_GAP_MS);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (!store.configs[id] || !store.configs[id].running) return stopRunner(id);
      }

      const outboundText = resolveSpintax(currentConfig.text);

      await channel.sendTyping().catch(() => {});
      const typingDuration = Math.min(Math.max(outboundText.length * 150, 1500), 6000);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      if (!store.configs[id] || !store.configs[id].running) return stopRunner(id);

      await channel.send({ content: outboundText, allowed_mentions: { parse: [] } });

      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      currentConfig.lastError = null;

      saveStore(store);
      if (refreshCardCallback) {
        refreshCardCallback(id, { force: false }).catch(() => {});
      }

      scheduleNext(currentConfig.delay, true);
    } catch (err) {
      const errStatus = err.status || err.httpStatus || err.response?.status;
      const errCode = Number(err?.code || err?.rawError?.code || 0);

      // 1. Isolate 401 Unauthorized: halt all pipelines for this user & destroy client
      if (isUnauthorizedError(err)) {
        const targetUserId = currentConfig.userId;
        console.error(`[Auth] Pipeline ${id} (user ${targetUserId}) hit 401 Unauthorized. Halting pipelines for re-auth.`);

        stopUserClient(targetUserId);
        userNextDispatchAt.delete(targetUserId);

        for (const [rKey, rSched] of Object.entries(store.staggered || {})) {
          if (rSched?.userId === targetUserId) {
            clearStaggeredTimer(rKey);
            delete store.staggered[rKey];
          }
        }

        const haltedIds = [];
        for (const [cfgId, cfg] of Object.entries(store.configs)) {
          if (cfg.userId === targetUserId && (cfg.running || cfgId === id)) {
            stopRunner(cfgId);
            cfg.running = false;
            cfg.startedAt = null;
            cfg.lastError =
              '🔐 Session Expired (401): Token rejected by Discord. Run `/add-token remove` then `/add-token register`.';
            haltedIds.push(cfgId);
          }
        }

        saveStore(store);
        for (const cfgId of haltedIds) {
          if (refreshCardCallback) refreshCardCallback(cfgId, { force: true }).catch(() => {});
        }

        await sendDM(targetUserId, {
          embeds: [{
            color: COLOR.red,
            title: '🔐 SESSION TOKEN EXPIRED (401 UNAUTHORIZED)',
            description:
              `Discord rejected the authentication token linked to your pipelines (**${haltedIds.length}** pipeline(s) paused automatically).\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `**How to Fix:**\n` +
              `1. Run \`/add-token remove\` to clear the expired session token.\n` +
              `2. Run \`/add-token register\` with a fresh token.\n` +
              `3. Restart your pipelines from your Command Center or \`/start-staggered\`.`,
            timestamp: new Date().toISOString(),
          }],
        }).catch(() => {});

        return;
      }

      // 2. Fatal per-pipeline errors (deleted channel, kicked from server, missing permissions)
      const fatalReason = getFatalChannelOrPermReason(err);
      if (fatalReason) {
        console.warn(`[Pipeline ${id}] Auto-paused due to fatal target error: ${fatalReason}`);
        stopRunner(id);
        currentConfig.running = false;
        currentConfig.startedAt = null;
        currentConfig.failed = (currentConfig.failed ?? 0) + 1;
        currentConfig.lastError = fatalReason;
        saveStore(store);

        if (refreshCardCallback) refreshCardCallback(id, { force: true }).catch(() => {});

        await sendDM(currentConfig.userId, {
          embeds: [{
            color: COLOR.red,
            title: '🛑 PIPELINE AUTO-PAUSED (TARGET CHANNEL ERROR)',
            description:
              `Your pipeline **\`${currentConfig.name}\`** targeting <#${currentConfig.channelId}> was **automatically paused** to protect your account from repeated failed requests.\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `**Reason:** ${fatalReason}\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `*Update the Channel ID or verify your server permissions before restarting this pipeline.*`,
            timestamp: new Date().toISOString(),
          }],
        }).catch(() => {});

        return;
      }

      // 3. Exact retry_after backoff on 429 rate limits / slowmode
      if (errStatus === 429 || errCode === 20016) {
        const retryAfter = Number(err?.retry_after || err?.rawError?.retry_after || 0);
        const backoffSec =
          retryAfter > 0
            ? Math.max(currentConfig.delay, Math.ceil(retryAfter) + 2)
            : currentConfig.delay * 2;
        console.warn(`Pipeline ${id}: Rate limited (429). Applying ${backoffSec}s backoff...`);
        scheduleNext(backoffSec, true);
        return;
      }

      // 4. Transient network timeouts
      const isNetworkTimeout =
        !errStatus &&
        (err.code === 'ETIMEDOUT' ||
          err.code === 'ENOTFOUND' ||
          err.code === 'ECONNRESET' ||
          err.message?.includes('fetch failed'));
      if (isNetworkTimeout) {
        console.warn(`Pipeline ${id}: Transient network delay skipped dispatch (${err.message})`);
        scheduleNext(currentConfig.delay, true);
        return;
      }

      // 5. Other recoverable dispatch errors
      console.error(`Pipeline ${id} dispatch error:`, err.message);

      const isCooldownOrSlowmode =
        err.message?.toLowerCase().includes('slowmode') ||
        err.message?.toLowerCase().includes('cooldown') ||
        err.message?.toLowerCase().includes('wait');

      const reasonTitle = isCooldownOrSlowmode
        ? '⏳ Channel Cooldown / Slowmode Active'
        : `Dispatch Failed: ${err.message}`;

      currentConfig.failed = (currentConfig.failed ?? 0) + 1;
      currentConfig.lastError = reasonTitle;
      saveStore(store);

      if (refreshCardCallback) refreshCardCallback(id, { force: false }).catch(() => {});

      await sendDM(currentConfig.userId, {
        embeds: [{
          color: COLOR.red,
          title: isCooldownOrSlowmode ? '⚠️ COOLDOWN DISPATCH WARNING' : '⚠️ AUTOMATEX DISPATCH NOTIFICATION',
          description:
            `Your pipeline **\`${currentConfig.name}\`** attempted to send a message to <#${currentConfig.channelId}> before the channel cooldown duration reset.\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `**Reason:** \`${err.message}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*Note:* Your pipeline is **still running** and will retry automatically once the cooldown clears.`,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});

      scheduleNext(currentConfig.delay, true);
    }
  };

  if (initialDelaySeconds !== null) {
    scheduleNext(initialDelaySeconds, false);
  } else if (immediate) {
    tick();
  } else {
    scheduleNext(c.delay, true);
  }
}

export function stopAllRunnersForUser(guildId, userId, store, saveStore) {
  cancelStaggeredRollout(guildId, userId, store, saveStore);
  userNextDispatchAt.delete(userId);
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
  runCleanupExpiredAccess(store, saveStore, stopRunner, clearStaggeredTimer);