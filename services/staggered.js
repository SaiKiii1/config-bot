// services/staggered.js
import { DEFAULT_STAGGER_SEC } from '../config/constants.js';
import { DiscordRequest } from '../utils/discord.js';
import { startRunner } from './runner.js';

const staggeredTimers = new Map();
const completionTimers = new Map();

export function clearStaggeredTimer(rolloutKey) {
  const handle = staggeredTimers.get(rolloutKey);
  if (handle) {
    clearTimeout(handle);
    staggeredTimers.delete(rolloutKey);
  }
  const completionHandle = completionTimers.get(rolloutKey);
  if (completionHandle) {
    clearTimeout(completionHandle);
    completionTimers.delete(rolloutKey);
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

async function sendStaggeredCompletionSummary(snapshot, store) {
  const { rolloutKey, guildId, userId, launchedIds, baselineStats, createdAt, totalRounds } = snapshot;

  const controllerChannelId =
    store.users?.[rolloutKey]?.controllerChannelId ||
    Object.values(store.configs || {}).find(
      (c) => c.guildId === guildId && c.userId === userId && c.controllerChannelId
    )?.controllerChannelId;

  if (!controllerChannelId) return;

  let sentCount = 0;
  let inFlightCount = 0;
  const failedItems = [];

  for (const cfgId of launchedIds) {
    const cfg = store.configs?.[cfgId];
    if (!cfg) continue;

    const base = baselineStats?.[cfgId] || { sent: 0, failed: 0 };
    const sentDelta = (cfg.sent ?? 0) - base.sent;
    const failedDelta = (cfg.failed ?? 0) - base.failed;

    if (sentDelta > 0 && !cfg.lastError) {
      sentCount++;
    } else if (failedDelta > 0 || cfg.lastError || !cfg.running) {
      const reason = cfg.lastError ? cfg.lastError.slice(0, 70) : 'Paused before dispatch';
      failedItems.push(`• **${cfg.name}** (\`${cfgId}\`) — ${reason}`);
    } else {
      inFlightCount++;
    }
  }

  const totalLaunched = launchedIds.length;
  const elapsedSec = Math.max(1, Math.round((Date.now() - createdAt) / 1000));
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const durationText = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const embedColor =
    failedItems.length === 0 ? 0x57f287 : sentCount > 0 ? 0xfee75c : 0xed4245;

  const fields = [
    { name: '🚀 Pipelines Launched', value: `**${totalLaunched}/${totalRounds}**`, inline: true },
    { name: '✅ Initial Send OK', value: `**${sentCount}**`, inline: true },
    { name: '❌ Failed / Issues', value: `**${failedItems.length}**`, inline: true },
    { name: '⏱ Total Rollout Time', value: `\`${durationText}\``, inline: true },
  ];

  if (inFlightCount > 0) {
    fields.push({ name: '⏳ Finishing Typing', value: `**${inFlightCount}**`, inline: true });
  }

  if (failedItems.length > 0) {
    const preview = failedItems.slice(0, 8).join('\n');
    const extra = failedItems.length > 8 ? `\n*...and ${failedItems.length - 8} more.*` : '';
    fields.push({
      name: '⚠️ Pipelines Needing Attention',
      value: `${preview}${extra}`,
      inline: false,
    });
  }

  await DiscordRequest(`channels/${controllerChannelId}/messages`, {
    method: 'POST',
    body: {
      content: `<@${userId}>`,
      allowed_mentions: { users: [userId] },
      embeds: [{
        color: embedColor,
        title: '🏁 STAGGERED ROLLOUT COMPLETE',
        description:
          'All queued pipelines in your `/start-staggered` wave have finished launching and are now running on their scheduled intervals.',
        fields,
        footer: { text: 'AutomateX Telemetry • Wave Summary' },
        timestamp: new Date().toISOString(),
      }],
    },
  }).catch((err) => {
    console.warn(`[Staggered] Could not send completion summary to ${controllerChannelId}:`, err.message);
  });
}

async function executeStaggeredRound(rolloutKey, store, saveStore, refreshCardCallback) {
  store.staggered ??= {};
  const schedule = store.staggered[rolloutKey];
  if (!schedule || schedule.status !== 'active') {
    clearStaggeredTimer(rolloutKey);
    return;
  }

  schedule.launchedConfigIds ??= [];
  let pendingIds = Array.isArray(schedule.pendingConfigIds) ? [...schedule.pendingConfigIds] : [];
  let nextCfgId = null;

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
    schedule.launchedConfigIds.push(nextCfgId);

    startRunner(nextCfgId, true, store, saveStore, refreshCardCallback);
    if (refreshCardCallback) refreshCardCallback(nextCfgId).catch(() => {});
  }

  const defaultGapMs = (DEFAULT_STAGGER_SEC || 20) * 1000;
  const isFinished = pendingIds.length === 0;
  const nextRunAt = Date.now() + Number(schedule.delayMs || defaultGapMs);

  if (isFinished) {
    console.log(
      `[Staggered] Completed rollout ${rolloutKey} (${schedule.currentRound}/${schedule.totalRounds} launched).`
    );
    const snapshot = {
      rolloutKey,
      guildId: schedule.guildId,
      userId: schedule.userId,
      launchedIds: [...schedule.launchedConfigIds],
      baselineStats: { ...(schedule.baselineStats || {}) },
      createdAt: schedule.createdAt || Date.now(),
      totalRounds: schedule.totalRounds || schedule.launchedConfigIds.length,
    };

    delete store.staggered[rolloutKey];
    clearStaggeredTimer(rolloutKey);
    saveStore(store);

    const summaryHandle = setTimeout(() => {
      completionTimers.delete(rolloutKey);
      sendStaggeredCompletionSummary(snapshot, store).catch((err) => {
        console.error(`[Staggered] Summary error for ${rolloutKey}:`, err.message);
      });
    }, 8500);
    completionTimers.set(rolloutKey, summaryHandle);
  } else {
    schedule.pendingConfigIds = pendingIds;
    schedule.nextRunAt = nextRunAt;
    schedule.updatedAt = Date.now();
    saveStore(store);
    armStaggeredTimer(rolloutKey, Number(schedule.delayMs || defaultGapMs), store, saveStore, refreshCardCallback);
  }

  pendingIds = null;
  nextCfgId = null;
}

export function startStaggeredRollout({
  guildId,
  userId,
  configIds,
  delaySeconds,
  store,
  saveStore,
  refreshCardCallback,
}) {
  store.staggered ??= {};
  store.users ??= {};
  const rolloutKey = `${guildId}:${userId}`;
  const cleanDelaySec = Math.max(1, Number(delaySeconds || DEFAULT_STAGGER_SEC || 20));
  const delayMs = cleanDelaySec * 1000;

  store.users[rolloutKey] = {
    ...(store.users[rolloutKey] || {}),
    staggerDelaySec: cleanDelaySec,
  };

  const baselineStats = {};
  for (const cfgId of configIds) {
    const cfg = store.configs?.[cfgId];
    if (cfg) {
      baselineStats[cfgId] = {
        sent: cfg.sent ?? 0,
        failed: cfg.failed ?? 0,
      };
    }
  }

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
    launchedConfigIds: [],
    baselineStats,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  store.staggered[rolloutKey] = schedule;
  saveStore(store);

  armStaggeredTimer(rolloutKey, 0, store, saveStore, refreshCardCallback);
  return schedule;
}

export function cancelStaggeredRollout(guildId, userId, store, saveStore) {
  store.staggered ??= {};
  const rolloutKey = `${guildId}:${userId}`;
  const existing = store.staggered[rolloutKey];
  clearStaggeredTimer(rolloutKey);
  if (!existing) return null;

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
    const earliestSlot = nextUserSlot.get(schedule.userId) ?? now + 2000;
    const targetRunAt = Math.max(now + 2000, Number(schedule.nextRunAt || 0), earliestSlot);
    const delayMs = targetRunAt - now;

    console.log(
      `[Recovery] Rollout ${rolloutKey} (Round ${(schedule.currentRound ?? 0) + 1}/${schedule.totalRounds}) scheduled in ${Math.round(delayMs / 1000)}s.`
    );
    armStaggeredTimer(rolloutKey, delayMs, store, saveStore, refreshCardCallback);
  }
}