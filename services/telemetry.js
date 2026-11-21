// services/telemetry.js
import { AUTO_SYNC_INTERVAL_MS, TELEMETRY_EDIT_INTERVAL_MS } from '../config/constants.js';
import { DiscordRequest } from '../utils/discord.js';
import { cardPanel } from '../ui/panels.js';

export function createTelemetry(store, save) {
  const lastCardEditAt = new Map();
  const lastInitialSendSyncedAt = new Map();
  const pendingForceIds = new Set();
  const telemetryQueue = [];
  const queuedCardIds = new Set();
  let isProcessingTelemetry = false;

  async function processTelemetryQueue() {
    if (isProcessingTelemetry) return;
    if (telemetryQueue.length === 0) return;

    isProcessingTelemetry = true;
    const id = telemetryQueue.shift();
    const isForced = pendingForceIds.has(id);
    pendingForceIds.delete(id);

    let nextDelay = TELEMETRY_EDIT_INTERVAL_MS;

    try {
      const c = store.configs[id];
      if (c?.cardMessageId && c?.controllerChannelId) {
        const lastEdit = lastCardEditAt.get(id) || 0;
        const withinThrottleWindow = !isForced && Date.now() - lastEdit < AUTO_SYNC_INTERVAL_MS;

        if (!withinThrottleWindow) {
          try {
            await DiscordRequest(`channels/${c.controllerChannelId}/messages/${c.cardMessageId}`, {
              method: 'PATCH',
              body: cardPanel(id, c),
            });
            lastCardEditAt.set(id, Date.now());
          } catch (err) {
            const code = err?.code || err?.rawError?.code;
            const msgText = String(err?.message || '');
            const hitEditLimit = code === 30046 || msgText.includes('30046') || msgText.includes('older than 1 hour');
            const missingMsg = err?.status === 404 || code === 10008 || msgText.includes('10008');

            if (hitEditLimit) {
              lastCardEditAt.set(id, Date.now());
              console.warn(`[Telemetry] Card ${id} hit 30046 hourly edit cap; backing off 7m.`);
            } else if (missingMsg) {
              c.cardMessageId = null;
              save();
              console.warn(`[Telemetry] Card ${id} message missing (404/10008); cleared stale message ID.`);
            } else if (err?.status === 429) {
              const retrySec = Number(err?.retry_after || err?.rawError?.retry_after || 5);
              nextDelay = Math.max(TELEMETRY_EDIT_INTERVAL_MS, Math.ceil(retrySec * 1000) + 250);
              console.warn(`[Telemetry] Rate limited on card ${id}; backing off ${nextDelay}ms.`);
            } else {
              console.error(`Failed to refresh telemetry card ${id}:`, msgText);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Telemetry] Update error for ${id}:`, err.message);
    } finally {
      queuedCardIds.delete(id);
      isProcessingTelemetry = false;
      if (telemetryQueue.length > 0) {
        setTimeout(processTelemetryQueue, nextDelay);
      }
    }
  }

  const refreshCard = async (id, { force = true } = {}) => {
    const c = store.configs[id];
    if (!c?.cardMessageId || !c?.controllerChannelId) return;

    const isFirstSendAfterStart =
      !force &&
      c.running &&
      c.startedAt &&
      c.lastSentAt &&
      c.lastSentAt >= c.startedAt &&
      lastInitialSendSyncedAt.get(id) !== c.startedAt;

    if (isFirstSendAfterStart) {
      lastInitialSendSyncedAt.set(id, c.startedAt);
      pendingForceIds.add(id);
    } else if (!force) {
      const lastEdit = lastCardEditAt.get(id) || 0;
      if (Date.now() - lastEdit < AUTO_SYNC_INTERVAL_MS) return;
    } else {
      pendingForceIds.add(id);
    }

    if (!queuedCardIds.has(id)) {
      queuedCardIds.add(id);
      telemetryQueue.push(id);
      processTelemetryQueue();
    }
  };

  return { refreshCard };
}