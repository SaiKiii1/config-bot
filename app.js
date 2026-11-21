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
import { InteractionType, InteractionResponseType, verifyKeyMiddleware } from 'discord-interactions';
import { DEFAULT_STAGGER_SEC } from './config/constants.js';
import { row, btn } from './ui/primitives.js';
import { modal } from './ui/modals.js';
import { setupPanel, cardPanel } from './ui/panels.js';
import { editOriginal } from './utils/discord.js';
import { loadStore, saveStore, flushStore, cleanupExpiredDrafts } from './utils/storage.js';
import { validate, parseDelay } from './utils/validators.js';
import { ensureController, repostCards } from './services/controller.js';
import { createTelemetry } from './services/telemetry.js';
import { startRunner, cleanupExpiredAccess, recoverStaggeredRollouts } from './services/runner.js';
import { startIdleClientSweeper } from './client-manager.js';
import { handleCommand } from './handlers/commands.js';
import { handleComponent, handleModalSubmit } from './handlers/components.js';
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

const { refreshCard } = createTelemetry(store, save);

const mineOf = (guildId, userId) =>
  Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId);

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

const boundRepostCards = (guildId, userId, controllerId) =>
  repostCards(guildId, userId, controllerId, store, save);

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
          data: { content: `❌ Unauthorized: Your ID (${userId}) does not match the configured admin ID.`, flags: 64 },
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
              { name: '6. Limitation of Liability', value: 'Provided on an "as-is" basis. Developers are not liable for any platform-imposed account suspensions or token invalidations.' },
            ],
            footer: { text: 'AutomateX • Secure. Automated. Reliable.' },
            timestamp: new Date().toISOString(),
          }],
        },
      });
    }

    try {
      await handleCommand(
        req,
        res,
        store,
        save,
        mineOf,
        ensureController,
        boundRepostCards,
        editOriginal,
        setupPanel,
        btn,
        row,
        refreshCard
      );
    } catch (err) {
      console.error(`Error handling command /${name}:`, err);
      if (!res.headersSent) {
        res.status(500).send({ error: 'Internal server error processing command.' });
      }
    }
  } else if (type === InteractionType.MESSAGE_COMPONENT) {
    await handleComponent(
      req,
      res,
      store,
      save,
      lookup,
      modal,
      setupPanel,
      cardPanel,
      validate,
      parseDelay,
      refreshCard,
      editOriginal,
      btn,
      row
    ).catch(console.error);
  } else if (type === InteractionType.MODAL_SUBMIT) {
    await handleModalSubmit(
      req,
      res,
      store,
      save,
      lookup,
      validate,
      parseDelay,
      refreshCard,
      setupPanel
    ).catch(console.error);
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

  for (const [id, c] of runningEntries) {
    const userKey = `${c.guildId}:${c.userId}`;
    const activeRollout = store.staggered?.[userKey];
    const savedStaggerSec = store.users?.[userKey]?.staggerDelaySec;
    const staggerGapMs = activeRollout?.delayMs
      ? Number(activeRollout.delayMs)
      : (savedStaggerSec ?? DEFAULT_STAGGER_SEC) * 1000;

    const naturalDueAt = c.lastSentAt
      ? c.lastSentAt + c.delay * 1000
      : now + c.delay * 1000;
    const earliestSlot = nextUserSlot.get(c.userId) ?? now + 3000;
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

let isShuttingDown = false;
async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}. Flushing store to database before exit...`);
  const forceExitTimer = setTimeout(() => process.exit(0), 4000);
  forceExitTimer.unref();
  try {
    await flushStore(store);
    console.log('[Shutdown] Store flushed successfully.');
  } catch (err) {
    console.error('[Shutdown] Failed to flush store:', err.message);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('SIGINT', () => handleShutdown('SIGINT'));