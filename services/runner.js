// services/runner.js
import { DiscordRequest, decryptCredential, sendDM, manageRole } from '../utils.js';
import { createSelfBotClient } from '../client-manager.js';

const timers = new Map();
const activeClients = new Map();

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

  const scheduleNext = (baseDelaySeconds) => {
    const currentConfig = store.configs[id];
    if (!currentConfig || !currentConfig.running) return;

    const jitterFactor = 1 + (Math.random() * 0.3 - 0.15);
    const delayMs = Math.floor(baseDelaySeconds * 1000 * jitterFactor);
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

        await manageRole(currentConfig.guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'DELETE');
        await manageRole(currentConfig.guildId, targetUser, process.env.MEMBER_ROLE_ID, 'PUT');

        sendDM(targetUser, {
          embeds: [{
            color: 0xfee75c,
            title: '🟡 SUBSCRIPTION ACCESS EXPIRED',
            description: `Hello <@${targetUser}>! Your AutomateX subscription access period has ended.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Security Action:** All your account token data, posting configurations, and controller channels have been cleared from the database.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Automated Security Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
          }]
        });
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
      let client = activeClients.get(currentConfig.userId);
      if (!client || !client.isReady()) {
        client = createSelfBotClient();
        await client.login(activeToken);
        activeClients.set(currentConfig.userId, client);
      }

      const channel = await client.channels.fetch(currentConfig.channelId);
      if (!channel) throw new Error('Target channel inaccessible.');

      await channel.sendTyping().catch(() => {});
      const typingDuration = Math.min(Math.max(currentConfig.text.length * 150, 1500), 6000);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      await channel.send({ content: currentConfig.text, allowed_mentions: { parse: [] } });
      
      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      if (currentConfig.sent % 10 === 0) saveStore(store);

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