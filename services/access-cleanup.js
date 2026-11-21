// services/access-cleanup.js
import { COLOR } from '../config/constants.js';
import { DiscordRequest, sendDM, manageRole } from '../utils/discord.js';
import { stopUserClient } from '../client-manager.js';

export async function purgeExpiredUser(
  userId,
  access,
  guildId,
  store,
  saveStore,
  stopRunnerFn,
  reasonText,
  clearRolloutFn = null
) {
  stopUserClient(userId);

  delete store.access[userId];
  delete store.credentials[userId];

  for (const [cfgId, cfg] of Object.entries(store.configs || {})) {
    if (cfg.userId === userId) {
      if (cfg.running && stopRunnerFn) stopRunnerFn(cfgId, store);
      DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, {
        method: 'DELETE',
      }).catch(() => {});
      delete store.configs[cfgId];
    }
  }

  for (const [rKey, rSched] of Object.entries(store.staggered || {})) {
    if (rSched?.userId === userId) {
      if (clearRolloutFn) clearRolloutFn(rKey);
      delete store.staggered[rKey];
    }
  }

  saveStore(store);

  const targetGuildId = guildId || process.env.GUILD_ID;
  if (targetGuildId) {
    await manageRole(targetGuildId, userId, process.env.SUBSCRIBER_ROLE_ID, 'DELETE').catch(() => {});
    await manageRole(targetGuildId, userId, process.env.MEMBER_ROLE_ID, 'PUT').catch(() => {});
  }

  await sendDM(userId, {
    embeds: [{
      color: COLOR.red,
      title: '⌛ SUBSCRIPTION ACCESS EXPIRED',
      description:
        `Hello <@${userId}>! Your AutomateX subscription access period (\`${access?.durationLabel || 'Standard Access'}\`) has ended.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Security Action:** ${reasonText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*AutomateX Automated Security Action*\n` +
        `<t:${Math.floor(Date.now() / 1000)}:F>`,
    }],
  }).catch(() => {});
}

export async function runCleanupExpiredAccess(store, saveStore, stopRunnerFn, clearRolloutFn = null) {
  const now = Date.now();
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  let updated = false;

  for (const [userId, access] of Object.entries(store.access || {})) {
    if (!access || access.expiresAt === 'permanent') continue;

    if (now > access.expiresAt) {
      console.log(`[Auto-Cleanup] Access expired for user ${userId}. Sweeping credentials & roles...`);
      await purgeExpiredUser(
        userId,
        access,
        process.env.GUILD_ID,
        store,
        saveStore,
        stopRunnerFn,
        'All registered account tokens, active pipelines, and controller channels have been purged.',
        clearRolloutFn
      );
    } else if (access.expiresAt - now <= TWENTY_FOUR_HOURS_MS && !access.warned24h) {
      access.warned24h = true;
      updated = true;
      const expireUnix = Math.floor(access.expiresAt / 1000);

      await sendDM(userId, {
        embeds: [{
          color: 0xfee75c,
          title: '⏰ SUBSCRIPTION EXPIRING IN LESS THAN 24 HOURS',
          description:
            `Hello <@${userId}>! Your AutomateX subscription (\`${access.durationLabel || 'Standard Access'}\`) will expire <t:${expireUnix}:R> (<t:${expireUnix}:F>).\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `**Heads Up:** Once a subscription expires, all saved configurations, registered tokens, and controller cards are automatically cleared.\n\n` +
            `👉 *Renew your pass in the store channel before expiration to keep your pipelines uninterrupted!*`,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
    }
  }

  if (updated) saveStore(store);
}