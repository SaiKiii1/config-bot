import { Blob } from 'node:buffer';
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}
global.File = globalThis.File;

// app.js
import 'dotenv/config';
import express from 'express';
import { getUserClient, startIdleClientSweeper } from './client-manager.js';
import { InteractionType, InteractionResponseType, verifyKeyMiddleware } from 'discord-interactions';
import { DiscordRequest, loadStore, saveStore, slug, privateOverwrites, decryptCredential, cleanupExpiredDrafts } from './utils.js';
import { startRunner, cleanupExpiredAccess, recoverStaggeredRollouts } from './services/runner.js';
import { handleCommand } from './handlers/commands.js';
import { handleComponent, handleModalSubmit, cardPanel } from './handlers/components.js';
import { sendWelcomeMessage } from './handlers/events.js';

const app = express();
const PORT = process.env.PORT || 8080;

const store = await loadStore();
store.users ??= {};
store.drafts ??= {};
store.configs ??= {};
store.credentials ??= {};
store.access ??= {};
store.staggered ??= {};
const save = () => saveStore(store);

const COLOR = { blurple: 0x5865f2, green: 0x57f287, red: 0xed4245, grey: 0x4f545c };
const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, custom_id, label, style, disabled });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unix = (ms) => Math.floor(ms / 1000);

function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

const mineOf = (guildId, userId) =>
  Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId);

function delayModal(mode, id, current) {
  const has = current != null;
  const parts = has ? { hours: Math.floor(current / 3600), minutes: Math.floor((current % 3600) / 60), seconds: current % 60 } : {};
  const input = (custom_id, label, placeholder) => row({ type: 4, custom_id, label, style: 1, required: false, max_length: 5, placeholder, ...(has ? { value: String(parts[custom_id]) } : {}) });
  return { type: InteractionResponseType.MODAL, data: { custom_id: `modal:${mode}:${id}:delay`, title: '⏱️ Set Execution Interval', components: [input('hours', 'Hours', '0'), input('minutes', 'Minutes', '0'), input('seconds', 'Seconds', '30')] } };
}

function modal(mode, id, field, current) {
  if (field === 'delay') return delayModal(mode, id, current);
  const titles = { name: '✏️ Rename Configuration', channelId: '📍 Configure Target Channel ID', text: '💬 Define Dispatch Payload' };
  const labels = { name: 'Configuration Name', channelId: 'Destination Channel ID', text: 'Message Body' };
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:${field}`,
      title: titles[field],
      components: [
        row({
          type: 4,
          custom_id: 'value',
          label: labels[field],
          style: field === 'text' ? 2 : 1,
          min_length: 1,
          max_length: field === 'text' ? 2000 : 50,
          required: true,
          value: current != null ? String(current) : undefined
        })
      ]
    }
  };
}

function setupPanel(id, d) {
  const hasChannel = Boolean(d.channelId);
  const hasDelay = Boolean(d.delay);
  const hasText = Boolean(d.text);
  const complete = hasChannel && hasDelay && hasText;
  
  let currentStep = 1;
  if (hasChannel && !hasDelay) currentStep = 2;
  else if (hasChannel && hasDelay && !hasText) currentStep = 3;
  else if (complete) currentStep = 3;

  const stepText = complete ? 'READY' : `STEP ${currentStep} OF 3`;
  const statusBadge = complete ? '🟢 READY' : '🟠 IN PROGRESS';
  const lineCount = d.text ? d.text.split('\n').length : 0;
  const previewText = d.text ? clip(d.text, 300) : '*Pending...*';

  return {
    content: `<@${d.userId}> Your pipeline setup environment is ready!`,
    embeds: [{
      color: complete ? COLOR.green : COLOR.blurple,
      title: `⚙️ AUTOMATEX SETUP WIZARD`,
      description: `**Configuring Pipeline:** \`${d.name}\`\n**Status:** ${statusBadge} managed by <@${d.userId}>\n\n**Progress: [ ${stepText} ]**\n1 Channel ${hasChannel ? '✓' : '•'}  ｜  2 Interval ${hasDelay ? '✓' : '•'}  ｜  3 Payload ${hasText ? '✓' : '•'}`,
      fields: [
        { name: '📍 DESTINATION CHANNEL', value: hasChannel ? `<#${d.channelId}>` : '*Pending...*', inline: true },
        { name: '⏱️ FREQUENCY INTERVAL', value: hasDelay ? `Every ${fmtDelay(d.delay)}` : '*Pending...*', inline: true },
        { name: '💬 PAYLOAD CONTENT', value: hasText ? `${lineCount} lines (${d.text.length} chars)\n> ${previewText}` : '*Pending...*' },
      ],
      footer: { text: 'AutomateX Setup Session expires in 10 minutes • Secure Wizard' },
      timestamp: new Date().toISOString()
    }],
    components: [
      row(
        btn(`set:draft:${id}:channelId`, 'Set Channel', 2),
        btn(`set:draft:${id}:delay`, 'Set Interval', 2),
        btn(`set:draft:${id}:text`, 'Set Message', 2)
      ),
      row(
        btn(`confirm:${id}`, 'Confirm', 3, !complete),
        btn(`cancel:${id}`, 'Abort', 4)
      )
    ],
  };
}

const controllerLocks = new Map();

async function ensureController(guildId, user) {
  const key = `${guildId}:${user.id}`;

  if (controllerLocks.has(key)) {
    return controllerLocks.get(key);
  }

  const task = (async () => {
    const existing = store.users[key]?.controllerChannelId;
    if (existing) {
      try {
        await DiscordRequest(`channels/${existing}`);
        return existing;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }

    const configWithController = mineOf(guildId, user.id).find(([, c]) => c.controllerChannelId);
    if (configWithController) {
      const recoveredId = configWithController[1].controllerChannelId;
      try {
        await DiscordRequest(`channels/${recoveredId}`);
        store.users[key] = { ...(store.users[key] || {}), controllerChannelId: recoveredId };
        save();
        return recoveredId;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }

    const expectedName = `controller-${slug(user.username)}`;
    try {
      const guildChannels = await DiscordRequest(`guilds/${guildId}/channels`);
      const match = guildChannels.find(
        (ch) =>
          ch.type === 0 &&
          ch.parent_id === process.env.CONTROLLER_CATEGORY_ID &&
          ch.name === expectedName &&
          Array.isArray(ch.permission_overwrites) &&
          ch.permission_overwrites.some((ow) => ow.id === user.id)
      );
      if (match) {
        store.users[key] = { ...(store.users[key] || {}), controllerChannelId: match.id };
        save();
        return match.id;
      }
    } catch (e) {
      console.warn('Could not scan guild channels for existing controller:', e.message);
    }

    const ch = await DiscordRequest(`guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: expectedName,
        type: 0,
        parent_id: process.env.CONTROLLER_CATEGORY_ID,
        topic: '🔒 Secured Command Center',
        permission_overwrites: privateOverwrites(guildId, user.id),
      },
    });
    store.users[key] = { ...(store.users[key] || {}), controllerChannelId: ch.id };
    save();
    return ch.id;
  })();

  controllerLocks.set(key, task);
  try {
    return await task;
  } finally {
    controllerLocks.delete(key);
  }
}

async function repostCards(guildId, userId, controllerId) {
  let restored = 0;
  for (const [id, c] of mineOf(guildId, userId)) {
    let ok = c.controllerChannelId === controllerId && c.cardMessageId;
    if (ok) {
      try { await DiscordRequest(`channels/${controllerId}/messages/${c.cardMessageId}`); } catch (e) { if (e.status === 404) ok = false; else throw e; }
    }
    if (!ok) {
      c.controllerChannelId = controllerId;
      try {
        const msg = await DiscordRequest(`channels/${controllerId}/messages`, { method: 'POST', body: cardPanel(id, c) });
        c.cardMessageId = msg.id;
        c.cardCreatedAt = Date.now();
        restored++;
      } catch (err) {
        console.error("Failed to restore card UI:", err.message);
      }
    }
  }
  if (restored) save();
  return restored;
}

// --- Serialized Telemetry Queue with 7-Minute Throttled Auto-Sync (Zero Card Duplication) ---
const AUTO_SYNC_INTERVAL_MS = 7 * 60 * 1000; // Max 1 background edit per 7m (~8.5/hr, below Discord's 30046 cap)
const TELEMETRY_EDIT_INTERVAL_MS = 1300; // 1.3s spacing between card PATCH calls
const lastCardEditAt = new Map();
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
      const withinThrottleWindow = !isForced && (Date.now() - lastEdit) < AUTO_SYNC_INTERVAL_MS;

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
            // Back off 7 minutes without deleting or reposting the card; Refresh button still works
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

  if (!force) {
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

async function validate(field, raw, guildId, userId) {
  if (field === 'name') return raw ? { value: raw.slice(0, 50) } : { error: 'Name cannot be blank.' };
  
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'Invalid Snowflake ID format.' };
    try {
      const userCreds = store.credentials[userId];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;
      if (!activeToken) return { error: 'Authentication missing. Run `/add-token register`.' };
      
      const client = await getUserClient(userId, activeToken.trim());
      const ch = await client.channels.fetch(raw);
      
      if (!ch || !['GUILD_TEXT', 'GUILD_NEWS'].includes(ch.type)) return { error: 'Must be a text channel.' };
    } catch (err) {
      console.error('Channel validation failed:', err.message);
      if (err.code === 10003) return { error: 'Channel does not exist or account lacks access.' };
      if (err.message.includes('401')) return { error: 'Token is invalid or session flagged by Discord.' };
      return { error: `Validation failed: ${err.message.slice(0, 80)}` };
    }
    return { value: raw };
  }
  
  if (field === 'text') return raw ? { value: raw } : { error: 'Payload body cannot be empty.' };
  return { error: 'Unknown field.' };
}

function parseDelay(v) {
  const [h, m, s] = ['hours', 'minutes', 'seconds'].map((k) => Number((v[k] ?? '').trim() || 0));
  const total = h * 3600 + m * 60 + s;
  if (total < 5 || total > 86400) return { error: 'Interval out of bounds (5s to 24h).' };
  return { value: total };
}

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

app.get('/health', (req, res) => res.send('ok'));

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async (req, res) => {
  const { type, data } = req.body;
  
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;
    const userId = req.body.member?.user?.id || req.body.user?.id;

    if (name === 'terms-of-service') {
      if (!userId || userId !== process.env.ADMIN_ID) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Unauthorized: Your ID (${userId}) does not match the configured admin ID.`, flags: 6 },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            title: '⚖️ AUTOMATEX — TERMS OF SERVICE',
            description: 'Welcome to AutomateX. By accessing, configuring, or interacting with AutomateX pipelines, automated modules, and token security vaults, you agree to abide by the following Terms of Service.',
            color: 0x3b82f6,
            fields: [
              { name: '1. Scope of Service & Educational Purpose', value: 'AutomateX is designed and maintained strictly as an advanced automation, telemetry logging, and protocol analysis framework for research and community management.' },
              { name: '2. User Account Responsibility & Security', value: 'You are solely responsible for the security of your authentication tokens and credentials. Never share raw tokens with third parties.' },
              { name: '3. Compliance & Platform Safety Heuristics', value: 'Automators incorporate safety jitters, but operators assume full responsibility for compliance with target platform Terms of Service.' },
              { name: '4. Prohibited Conduct', value: 'Mass spamming, phishing, targeted harassment, or unauthorized access attempts will result in immediate termination of access.' },
              { name: '5. Platform Advisory & Account Health', value: 'While AutomateX uses smart pre-flight checks and humanized jitter, running automation on platforms like Discord involves strict platform-specific policies. To protect your standing, please use the system with care and avoid reckless setups—always opt for well-aged accounts to prevent unnecessary flags, bans, or suspensions!' },
              { name: '6. Limitation of Liability', value: 'Provided on an "as-is" basis. Developers are not liable for any platform-imposed account suspensions or token invalidations.' }
            ],
            footer: { text: 'AutomateX • Secure. Automated. Reliable.' },
            timestamp: new Date().toISOString()
          }]
        }
      });
    }

    try {
      await handleCommand(req, res, store, save, mineOf, ensureController, repostCards, editOriginal, setupPanel, btn, row, refreshCard);
    } catch (err) {
      console.error(`Error handling command /${name}:`, err);
      if (!res.headersSent) {
        res.status(500).send({ error: 'Internal server error processing command.' });
      }
    }
  } else if (type === InteractionType.MESSAGE_COMPONENT) {
    // CRITICAL FIX: Await handleComponent so Express doesn't drop the connection before res.send()
    await handleComponent(req, res, store, save, lookup, modal, setupPanel, handleComponent, validate, parseDelay, refreshCard, editOriginal, btn, row).catch(console.error);
  } else if (type === InteractionType.MODAL_SUBMIT) {
    await handleModalSubmit(req, res, store, save, lookup, validate, parseDelay, refreshCard, setupPanel).catch(console.error);
  } else {
    res.status(400).json({ error: 'unknown interaction' });
  }
});

app.post('/events', express.json(), (req, res) => {
  const event = req.body;
  if (event && event.type === 'GUILD_MEMBER_ADD') {
      const member = event.data;
      sendWelcomeMessage(member.user.id, process.env.WELCOME_CHANNEL_ID).catch(console.error);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);

  const toBigInt = (val) => {
    try {
      return val ? BigInt(val) : 0n;
    } catch {
      return 0n;
    }
  };

  const runningEntries = Object.entries(store.configs)
    .filter(([, c]) => c.running)
    .sort(([, a], [, b]) => {
      const idA = toBigInt(a.cardMessageId);
      const idB = toBigInt(b.cardMessageId);
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

  const now = Date.now();
  const nextUserSlot = new Map();
  const DEFAULT_STAGGER_SEC = 20;

  for (const [id, c] of runningEntries) {
    const userKey = `${c.guildId}:${c.userId}`;
    const activeRollout = store.staggered?.[userKey];
    const savedStaggerSec = store.users?.[userKey]?.staggerDelaySec;
    const staggerGapMs = activeRollout?.delayMs
      ? Number(activeRollout.delayMs)
      : (savedStaggerSec ?? DEFAULT_STAGGER_SEC) * 1000;

    const naturalDueAt = c.lastSentAt
      ? c.lastSentAt + (c.delay * 1000)
      : now + (c.delay * 1000);
    const earliestSlot = nextUserSlot.get(c.userId) ?? (now + 3000);
    const scheduledAt = Math.max(now + 3000, naturalDueAt, earliestSlot);

    nextUserSlot.set(c.userId, scheduledAt + staggerGapMs);

    const initialDelaySec = Math.max(3, Math.round((scheduledAt - now) / 1000));
    startRunner(id, false, store, save, refreshCard, initialDelaySec);
  }

  recoverStaggeredRollouts(store, save, refreshCard, nextUserSlot);
  startIdleClientSweeper(store);

  cleanupExpiredAccess(store, save).catch(console.error);
  cleanupExpiredDrafts(store, save).catch(console.error);

  setInterval(() => {
    cleanupExpiredAccess(store, save).catch(console.error);
    cleanupExpiredDrafts(store, save).catch(console.error);
  }, 15 * 60 * 1000);
});