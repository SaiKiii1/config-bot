// services/runner.js
import { DiscordRequest, decryptCredential, sendDM, manageRole } from '../utils.js';
import { getUserClient, stopUserClient } from '../client-manager.js';

const timers = new Map();
const staggeredTimers = new Map();

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

export function stopRunner(id, store) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export function startRunner(id, immediate = true, store, saveStore, refreshCardCallback, initialDelaySeconds = null) {
  stopRunner(id, store);
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
    if (!currentConfig || !currentConfig.running) return stopRunner(id, store);

    const ADMIN_ID = process.env.ADMIN_ID;
    const access = store.access[currentConfig.userId];
    const now = Date.now();
    
    if (currentConfig.userId !== ADMIN_ID) {
      if (access && access.expiresAt !== 'permanent' && now > access.expiresAt) {
        const targetUser = currentConfig.userId;
        
        stopUserClient(targetUser);

        delete store.access[targetUser];
        delete store.credentials[targetUser];
        
        for (const [cfgId, cfg] of Object.entries(store.configs)) {
          if (cfg.userId === targetUser) {
            if (cfg.running) stopRunner(cfgId, store);
            DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
            delete store.configs[cfgId];
          }
        }
        saveStore(store);

        await manageRole(currentConfig.guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'DELETE').catch(() => {});
        await manageRole(currentConfig.guildId, targetUser, process.env.MEMBER_ROLE_ID, 'PUT').catch(() => {});

        await sendDM(targetUser, {
          embeds: [{
            color: 0xed4245,
            title: '⌛ SUBSCRIPTION ACCESS EXPIRED',
            description: `Hello <@${targetUser}>! Your AutomateX subscription access period (\`${access.durationLabel || 'Standard Access'}\`) has officially ended.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Security Action:** All your account token data, posting configurations, and controller channels have been cleared from the database.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Automated Security Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
          }]
        }).catch(() => {});
        return;
      } else if (!access) {
        currentConfig.running = false;
        currentConfig.startedAt = null;
        currentConfig.lastError = '⚠️ Access Denied: Security clearance not found.';
        saveStore(store);
        if (refreshCardCallback) refreshCardCallback(id).catch(() => {});
        return stopRunner(id, store);
      }
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
      const client = await getUserClient(currentConfig.userId, activeToken);

      const channel = await client.channels.fetch(currentConfig.channelId);
      if (!channel) throw new Error('Target channel inaccessible.');

      await channel.sendTyping().catch(() => {});
      const typingDuration = Math.min(Math.max(currentConfig.text.length * 150, 1500), 6000);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      await channel.send({ content: currentConfig.text, allowed_mentions: { parse: [] } });
      
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

      // Isolate 401 Unauthorized: halt user's pipelines, abort active staggered rollout & destroy client
      if (isUnauthorizedError(err)) {
        const targetUserId = currentConfig.userId;
        console.error(`[Auth] Pipeline ${id} (user ${targetUserId}) hit 401 Unauthorized. Halting pipelines for re-auth.`);

        stopUserClient(targetUserId);

        for (const [rKey, rSched] of Object.entries(store.staggered || {})) {
          if (rSched?.userId === targetUserId) {
            clearStaggeredTimer(rKey);
            delete store.staggered[rKey];
          }
        }

        const haltedIds = [];
        for (const [cfgId, cfg] of Object.entries(store.configs)) {
          if (cfg.userId === targetUserId && (cfg.running || cfgId === id)) {
            stopRunner(cfgId, store);
            cfg.running = false;
            cfg.startedAt = null;
            cfg.lastError = '🔐 Session Expired (401): Token rejected by Discord. Run `/add-token remove` then `/add-token register`.';
            haltedIds.push(cfgId);
          }
        }

        saveStore(store);
        for (const cfgId of haltedIds) {
          if (refreshCardCallback) refreshCardCallback(cfgId).catch(() => {});
        }

        await sendDM(targetUserId, {
          embeds: [{
            color: 0xed4245,
            title: '🔐 SESSION TOKEN EXPIRED (401 UNAUTHORIZED)',
            description: `Discord rejected the authentication token linked to your pipelines (**${haltedIds.length}** pipeline(s) paused automatically).\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**How to Fix:**\n1. Run \`/add-token remove\` to clear the expired session token.\n2. Run \`/add-token register\` with a fresh token.\n3. Restart your pipelines from your Command Center or \`/start-staggered\`.`,
            timestamp: new Date().toISOString()
          }]
        }).catch(() => {});

        return;
      }

      if (errStatus === 429) {
        console.warn(`Pipeline ${id}: Rate limited (429). Applying backoff penalty...`);
        scheduleNext(currentConfig.delay * 2, true);
        return;
      }

      const isNetworkTimeout = !errStatus && (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.message?.includes('fetch failed'));
      if (isNetworkTimeout) {
        console.warn(`Pipeline ${id}: Transient network delay skipped dispatch (${err.message})`);
        scheduleNext(currentConfig.delay, true);
        return;
      }
      
      console.error(`Pipeline ${id} dispatch error:`, err.message);
      
      const isCooldownOrSlowmode = 
        errStatus === 429 || 
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
          color: 0xed4245,
          title: isCooldownOrSlowmode ? '⚠️ COOLDOWN DISPATCH WARNING' : '⚠️ AUTOMATEX DISPATCH NOTIFICATION',
          description: `Your pipeline **\`${currentConfig.name}\`** attempted to send a message to <#${currentConfig.channelId}> before the channel cooldown duration reset.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Reason:** \`${err.message}\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Note:* Your pipeline is **still running** and will retry automatically once the cooldown clears.`,
          timestamp: new Date().toISOString()
        }]
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

// --- PERSISTENT STAGGERED ROLLOUT ENGINE ---

function clearStaggeredTimer(rolloutKey) {
  const handle = staggeredTimers.get(rolloutKey);
  if (handle) {
    clearTimeout(handle);
    staggeredTimers.delete(rolloutKey);
  }
}

function armStaggeredTimer(rolloutKey, delayMs, store, saveStore, refreshCardCallback) {
  clearStaggeredTimer(rolloutKey);
  const safeDelay = Math.max(0, delayMs);
  const handle = setTimeout(() => {
    executeStaggeredRound(rolloutKey, store, saveStore, refreshCardCallback).catch((err) => {
      console.error(`[Staggered] Round error for ${rolloutKey}:`, err.message);
    });
  }, safeDelay);
  staggeredTimers.set(rolloutKey, handle);
}

async function executeStaggeredRound(rolloutKey, store, saveStore, refreshCardCallback) {
  store.staggered ??= {};
  const schedule = store.staggered[rolloutKey];
  if (!schedule || schedule.status !== 'active') {
    clearStaggeredTimer(rolloutKey);
    return;
  }

  let pendingIds = Array.isArray(schedule.pendingConfigIds) ? [...schedule.pendingConfigIds] : [];
  let nextCfgId = null;

  // Pop the next valid, unstarted configuration ID
  while (pendingIds.length > 0) {
    const candidateId = pendingIds.shift();
    const candidateCfg = store.configs[candidateId];
    if (candidateCfg && !candidateCfg.running) {
      nextCfgId = candidateId;
      break;
    }
  }

  if (nextCfgId) {
    const cfg = store.configs[nextCfgId];
    cfg.running = true;
    cfg.lastError = null;
    cfg.startedAt = Date.now();
    schedule.currentRound = (schedule.currentRound ?? 0) + 1;

    startRunner(nextCfgId, true, store, saveStore, refreshCardCallback);
    if (refreshCardCallback) refreshCardCallback(nextCfgId).catch(() => {});
  }

  const isFinished = pendingIds.length === 0;
  const nextRunAt = Date.now() + Number(schedule.delayMs || 20000);

  if (isFinished) {
    console.log(`[Staggered] Completed rollout ${rolloutKey} (${schedule.currentRound}/${schedule.totalRounds} launched).`);
    delete store.staggered[rolloutKey];
    clearStaggeredTimer(rolloutKey);
    saveStore(store);
  } else {
    schedule.pendingConfigIds = pendingIds;
    schedule.nextRunAt = nextRunAt;
    schedule.updatedAt = Date.now();
    saveStore(store);
    armStaggeredTimer(rolloutKey, Number(schedule.delayMs || 20000), store, saveStore, refreshCardCallback);
  }

  // Explicitly dereference round arrays so V8 reclaims memory immediately
  pendingIds = null;
  nextCfgId = null;
}

export function startStaggeredRollout({ guildId, userId, configIds, delaySeconds, store, saveStore, refreshCardCallback }) {
  store.staggered ??= {};
  store.users ??= {};
  const rolloutKey = `${guildId}:${userId}`;
  const cleanDelaySec = Math.max(1, Number(delaySeconds || 20));
  const delayMs = cleanDelaySec * 1000;

  // Persist user's preferred stagger interval for future boot recoveries
  store.users[rolloutKey] = {
    ...(store.users[rolloutKey] || {}),
    staggerDelaySec: cleanDelaySec,
  };

  const schedule = {
    id: rolloutKey,
    guildId,
    userId,
    status: 'active',
    currentRound: 0,
    totalRounds: configIds.length,
    delayMs,
    nextRunAt: Date.now(),
    pendingConfigIds: [...configIds],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  store.staggered[rolloutKey] = schedule;
  saveStore(store);

  // Execute Round 1 immediately
  armStaggeredTimer(rolloutKey, 0, store, saveStore, refreshCardCallback);
  return schedule;
}

export function cancelStaggeredRollout(guildId, userId, store, saveStore) {
  store.staggered ??= {};
  const rolloutKey = `${guildId}:${userId}`;
  const existing = store.staggered[rolloutKey];
  if (!existing) return null;

  clearStaggeredTimer(rolloutKey);
  delete store.staggered[rolloutKey];
  saveStore(store);
  return existing;
}

export function recoverStaggeredRollouts(store, saveStore, refreshCardCallback, nextUserSlot = new Map()) {
  store.staggered ??= {};
  const entries = Object.entries(store.staggered).filter(([, s]) => s && s.status === 'active');
  if (!entries.length) return;

  console.log(`[Recovery] Found ${entries.length} active staggered rollout(s) to resume.`);
  const now = Date.now();

  for (const [rolloutKey, schedule] of entries) {
    const earliestSlot = nextUserSlot.get(schedule.userId) ?? (now + 2000);
    const targetRunAt = Math.max(now + 2000, Number(schedule.nextRunAt || 0), earliestSlot);
    const delayMs = targetRunAt - now;

    console.log(
      `[Recovery] Rollout ${rolloutKey} (Round ${(schedule.currentRound ?? 0) + 1}/${schedule.totalRounds}) scheduled in ${Math.round(delayMs / 1000)}s.`
    );
    armStaggeredTimer(rolloutKey, delayMs, store, saveStore, refreshCardCallback);
  }
}

export function stopAllRunnersForUser(guildId, userId, store, saveStore, refreshCardCallback) {
  cancelStaggeredRollout(guildId, userId, store, saveStore);
  const mine = Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId && c.running);
  for (const [id, c] of mine) {
    stopRunner(id, store);
    c.running = false;
    c.startedAt = null;
  }
  if (mine.length) saveStore(store);
  return mine;
}

export async function cleanupExpiredAccess(store, saveStore) {
  const now = Date.now();
  let updated = false;

  for (const [userId, access] of Object.entries(store.access || {})) {
    if (access && access.expiresAt !== 'permanent' && now > access.expiresAt) {
      console.log(`[Auto-Cleanup] Access expired for user ${userId}. Sweeping credentials & roles...`);
      
      stopUserClient(userId);

      delete store.access[userId];
      delete store.credentials[userId];

      for (const [cfgId, cfg] of Object.entries(store.configs || {})) {
        if (cfg.userId === userId) {
          if (cfg.running) stopRunner(cfgId, store);
          DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
          delete store.configs[cfgId];
        }
      }

      for (const [rKey, rSched] of Object.entries(store.staggered || {})) {
        if (rSched?.userId === userId) {
          clearStaggeredTimer(rKey);
          delete store.staggered[rKey];
        }
      }

      const primaryGuildId = process.env.GUILD_ID;
      if (primaryGuildId) {
        await manageRole(primaryGuildId, userId, process.env.SUBSCRIBER_ROLE_ID, 'DELETE').catch(() => {});
        await manageRole(primaryGuildId, userId, process.env.MEMBER_ROLE_ID, 'PUT').catch(() => {});
      }

      await sendDM(userId, {
        embeds: [{
          color: 0xed4245,
          title: '⌛ SUBSCRIPTION ACCESS EXPIRED',
          description: `Hello <@${userId}>! Your AutomateX access subscription period (\`${access.durationLabel || 'Standard Access'}\`) has ended.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Security Action:** All registered account tokens, active pipelines, and controller channels have been purged.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Security Sweep*\n<t:${Math.floor(Date.now() / 1000)}:F>`
        }]
      }).catch(() => {});

      updated = true;
    }
  }

  if (updated) saveStore(store);
}