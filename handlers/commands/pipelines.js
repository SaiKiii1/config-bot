// handlers/commands/pipelines.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { COLOR, MAX_OPEN_SETUPS, getMaxConfigs } from '../../config/constants.js';
import { row, btn, reply, ephemeral, notice, fmtDelay } from '../../ui/primitives.js';
import { DiscordRequest, privateOverwrites } from '../../utils/discord.js';
import { decryptCredential } from '../../utils/crypto.js';
import { slug, previewSpintax } from '../../utils/validators.js';
import { getUserClient } from '../../client-manager.js';
import {
  stopAllRunnersForUser,
  stopRunner,
  startStaggeredRollout,
  cancelStaggeredRollout,
} from '../../services/runner.js';

export function handleListConfigs(req, res, ctx) {
  const { user, guildId, store, mineOf } = ctx;
  const mine = mineOf(guildId, user.id);
  if (!mine.length) {
    return notice(res, COLOR.blurple, '📭 Zero Pipelines Active', 'Run `/add-config` to provision your first automation channel.');
  }

  const ctrl = store.users[`${guildId}:${user.id}`]?.controllerChannelId;
  const maxConfigs = getMaxConfigs(user.id, store);
  const limitLabel = maxConfigs === Infinity ? '∞' : maxConfigs;

  return reply(res, {
    embeds: [{
      color: COLOR.blurple,
      title: `📋 Configuration Registry (${mine.length}/${limitLabel})`,
      description: ctrl ? `Manage active pipelines in <#${ctrl}>.` : undefined,
      fields: mine.map(([cfgId, c]) => ({
        name: `${c.running ? '🟢' : '🔴'} ${c.name.slice(0, 180)} (\`${cfgId}\`)`,
        value: `Dest: <#${c.channelId}> · Dispatches: \`${c.sent ?? 0}\``,
      })),
    }],
  });
}

export function handleDeleteAllConfigs(req, res, ctx) {
  const { user, guildId, mineOf } = ctx;
  const mine = mineOf(guildId, user.id);
  if (!mine.length) {
    return notice(res, COLOR.amber, '📭 Zero Pipelines Found', 'You do not have any active or saved configurations to delete.');
  }

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `⚠️ **Danger Zone**: Are you sure you want to permanently delete **all ${mine.length}** of your configuration pipelines and their controller cards?`,
      flags: 64,
      components: [
        row(
          btn(`confirm_delete_all:${guildId}`, 'Yes, Delete All', 4),
          btn('delete_no', 'Abort', 2)
        ),
      ],
    },
  });
}

export async function handleStopAll(req, res, ctx) {
  const { user, guildId, token, store, saveStore, refreshCard, editOriginal } = ctx;
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  const rolloutKey = `${guildId}:${user.id}`;
  const hadActiveRollout = store.staggered?.[rolloutKey]?.status === 'active';
  const stopped = stopAllRunnersForUser(guildId, user.id, store, saveStore);

  await Promise.allSettled(stopped.map(([id]) => refreshCard(id)));

  await editOriginal(token, {
    content: stopped.length
      ? `⏹️ **Emergency Halt**: Successfully terminated ${stopped.length} active pipeline(s)${hadActiveRollout ? ', aborted the in-progress staggered rollout,' : ''} and synced controller cards.`
      : hadActiveRollout
        ? '⏹️ **Emergency Halt**: Aborted the in-progress staggered rollout. No active pipelines were running.'
        : 'ℹ️ No active pipelines were running.',
  }).catch(() => {});
}

export function handlePauseErrors(req, res, ctx) {
  const { user, guildId, store, saveStore, mineOf, refreshCard } = ctx;
  const erroredRunning = mineOf(guildId, user.id).filter(([, c]) => c.running && Boolean(c.lastError));

  if (!erroredRunning.length) {
    return notice(res, COLOR.green, '✅ All Running Pipelines Healthy', 'None of your currently running pipelines have dispatch errors.');
  }

  for (const [cfgId, c] of erroredRunning) {
    stopRunner(cfgId, store);
    c.running = false;
    c.startedAt = null;
    refreshCard(cfgId).catch(() => {});
  }
  saveStore(store);

  const preview = erroredRunning
    .slice(0, 10)
    .map(([cfgId, c]) => `• **${c.name}** (\`${cfgId}\`)`)
    .join('\n');
  const extra = erroredRunning.length > 10 ? `\n*...and ${erroredRunning.length - 10} more.*` : '';

  return notice(
    res,
    COLOR.amber,
    `⏸️ Paused ${erroredRunning.length} Failing Pipeline(s)`,
    `The following pipelines were paused so healthy pipelines can continue unaffected:\n\n${preview}${extra}`
  );
}

export function handleEditDelayAll(req, res, ctx) {
  const { user, guildId, options, store, saveStore, mineOf, refreshCard } = ctx;
  const newSeconds = options.find((o) => o.name === 'seconds')?.value;
  const scope = options.find((o) => o.name === 'scope')?.value || 'all';

  if (!newSeconds || newSeconds < 5 || newSeconds > 86400) {
    return ephemeral(res, '⚠️ Interval must be between **5 seconds** and **86,400 seconds** (24 hours).');
  }

  const targets = mineOf(guildId, user.id).filter(([, c]) => (scope === 'paused' ? !c.running : true));
  if (!targets.length) {
    return notice(
      res,
      COLOR.amber,
      '📭 No Matching Pipelines',
      scope === 'paused'
        ? 'You have no paused pipelines to update.'
        : 'You do not have any saved pipelines yet. Run `/add-config` first.'
    );
  }

  for (const [cfgId, c] of targets) {
    c.delay = newSeconds;
    refreshCard(cfgId).catch(() => {});
  }
  saveStore(store);

  return notice(
    res,
    COLOR.green,
    '⏱️ Bulk Interval Updated',
    `Updated **${targets.length}** ${scope === 'paused' ? 'paused ' : ''}pipeline(s) to dispatch every **${fmtDelay(newSeconds)}** (\`${newSeconds}s\`).\n*Running pipelines will apply the new interval on their next cycle.*`
  );
}

export function handlePreviewSpintax(req, res, ctx) {
  const { user, guildId, options, mineOf } = ctx;
  const sourceQuery = options.find((o) => o.name === 'source')?.value?.trim();
  const customText = options.find((o) => o.name === 'text')?.value;

  let rawTemplate = customText;
  let label = 'Custom Text Input';

  if (!rawTemplate && sourceQuery) {
    const matched = mineOf(guildId, user.id).find(
      ([cfgId, c]) => cfgId === sourceQuery || c.name.toLowerCase() === sourceQuery.toLowerCase()
    );
    if (!matched) {
      return notice(
        res,
        COLOR.amber,
        '🔍 Configuration Not Found',
        `Could not find any pipeline matching \`${sourceQuery}\`. Check the Config ID on your card or run \`/list-configs\`.`
      );
    }
    rawTemplate = matched[1].text;
    label = `${matched[1].name} (\`${matched[0]}\`)`;
  }

  if (!rawTemplate) {
    return ephemeral(res, '⚠️ Provide either a `source` config ID/name or custom `text` to preview.');
  }

  const samples = Array.from(
    { length: 4 },
    (_, i) => `**Sample ${i + 1}:**\n> ${previewSpintax(rawTemplate).slice(0, 420)}`
  );

  return reply(res, {
    embeds: [{
      color: COLOR.blurple,
      title: `🎲 Spintax Dry-Run Preview — ${label}`,
      description: samples.join('\n\n'),
      footer: { text: 'Dry-run only • No messages were sent to any channel' },
    }],
  });
}

export function handleStartStaggered(req, res, ctx) {
  const { user, guildId, options, store, saveStore, mineOf, refreshCard } = ctx;
  store.staggered ??= {};
  const rolloutKey = `${guildId}:${user.id}`;
  const existing = store.staggered[rolloutKey];

  if (existing && existing.status === 'active') {
    const nextUnix = Math.floor((existing.nextRunAt || Date.now()) / 1000);
    return ephemeral(
      res,
      `⚠️ A staggered rollout is already in progress (**${existing.currentRound}/${existing.totalRounds}** launched, next round <t:${nextUnix}:R>). Run \`/cancel-staggered\` first if you want to abort and restart it.`
    );
  }

  const delaySecs = options.find((o) => o.name === 'delay_seconds')?.value || 20;
  const orderMode = options.find((o) => o.name === 'order')?.value || 'random';
  const mine = mineOf(guildId, user.id).filter(([, c]) => !c.running);

  if (!mine.length) {
    return ephemeral(res, 'ℹ️ All of your configuration pipelines are already running or you have no active configs!');
  }

  let configIds;
  if (orderMode === 'top_to_bottom') {
    const toBigInt = (val) => {
      try {
        return val ? BigInt(val) : 0n;
      } catch {
        return 0n;
      }
    };
    configIds = [...mine]
      .sort(([, a], [, b]) => {
        const idA = toBigInt(a.cardMessageId);
        const idB = toBigInt(b.cardMessageId);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      })
      .map(([cfgId]) => cfgId);
  } else {
    // Fisher-Yates shuffle (default: random)
    configIds = mine.map(([cfgId]) => cfgId);
    for (let i = configIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [configIds[i], configIds[j]] = [configIds[j], configIds[i]];
    }
  }

  const orderLabel = orderMode === 'top_to_bottom' ? '⬇️ Top to Bottom' : '🎲 Randomized';
  const totalDurationSec = (configIds.length - 1) * delaySecs;
  const estFinishUnix = Math.floor((Date.now() + totalDurationSec * 1000) / 1000);

  startStaggeredRollout({
    guildId,
    userId: user.id,
    configIds,
    delaySeconds: delaySecs,
    store,
    saveStore,
    refreshCardCallback: refreshCard,
  });

  return reply(res, {
    content:
      `🚀 **Staggered Launch Initiated (Saved to Database)!**\n` +
      `Activating **${configIds.length}** pipeline(s) in **${orderLabel}** order with a **${delaySecs}-second** gap between each.\n` +
      `⏱️ **Estimated Completion:** <t:${estFinishUnix}:R>\n` +
      `🛡️ *Progress is persisted automatically—even if the server restarts mid-rollout, remaining rounds will resume on schedule.*\n` +
      `*(Use \`/cancel-staggered\` at any time to stop the rollout.)*`,
  });
}

export function handleCancelStaggered(req, res, ctx) {
  const { user, guildId, store, saveStore } = ctx;
  const cancelled = cancelStaggeredRollout(guildId, user.id, store, saveStore);

  if (!cancelled) {
    return ephemeral(res, 'ℹ️ You do not have an active `/start-staggered` rollout in progress.');
  }

  return reply(res, {
    content:
      `🛑 **Staggered Rollout Cancelled**: Stopped launching remaining pipelines (**${cancelled.currentRound}/${cancelled.totalRounds}** already activated).\n` +
      `*Note: Already-started pipelines will keep running. Use \`/stop-all\` to pause them.*`,
  });
}

export async function handleDuplicateConfig(req, res, ctx) {
  const { user, guildId, options, token, store, saveStore, mineOf, ensureController, repostCards, editOriginal } = ctx;
  const userCreds = store.credentials[user.id];
  const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
  const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

  if (!activeToken) {
    return notice(
      res,
      COLOR.red,
      '🚫 Authorization Blocked',
      'Security policy requires a registered user credential before duplicating pipelines.\n\n👉 Run `/add-token register` first.'
    );
  }

  const sourceQuery = options.find((o) => o.name === 'source')?.value?.trim();
  const newChannelId = options.find((o) => o.name === 'channel_id')?.value?.trim();
  const customName = options.find((o) => o.name === 'name')?.value?.trim()?.slice(0, 50);

  if (!sourceQuery || !newChannelId) {
    return ephemeral(res, '⚠️ Please provide both the source config ID/name and the target Channel ID.');
  }

  if (!/^\d{17,20}$/.test(newChannelId)) {
    return ephemeral(res, '⚠️ Invalid Channel ID format. Please provide a valid 17–20 digit Discord Channel Snowflake ID.');
  }

  const maxConfigs = getMaxConfigs(user.id, store);
  const saved = mineOf(guildId, user.id).length;
  const open = Object.values(store.drafts || {}).filter((d) => d.userId === user.id && d.guildId === guildId).length;

  if (saved + open >= maxConfigs) {
    const limitStr = maxConfigs === Infinity ? 'Unlimited' : maxConfigs;
    const tierLabel = store.access[user.id]?.durationLabel || 'Free Trial';
    return notice(
      res,
      COLOR.red,
      '⚠️ Quota Exceeded',
      `Maximum limit of **${limitStr}** configuration(s) reached for your clearance tier (\`${tierLabel}\`).${
        maxConfigs !== Infinity ? '\n\n👉 *Upgrade your pass in the store channel to unlock more configuration slots!*' : ''
      }`
    );
  }

  const mine = mineOf(guildId, user.id);
  const matched = mine.find(
    ([cfgId, cfg]) => cfgId === sourceQuery || cfg.name.toLowerCase() === sourceQuery.toLowerCase()
  );

  if (!matched) {
    return notice(
      res,
      COLOR.amber,
      '🔍 Configuration Not Found',
      `Could not find any pipeline matching \`${sourceQuery}\`.\n\nCheck the short ID printed on your controller card (e.g., \`rq77h1\`) or run \`/list-configs\`.`
    );
  }

  const [sourceId, sourceCfg] = matched;

  try {
    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });

    const client = await getUserClient(user.id, activeToken.trim());
    const ch = await client.channels.fetch(newChannelId);
    if (!ch || !['GUILD_TEXT', 'GUILD_NEWS'].includes(ch.type)) {
      return editOriginal(token, {
        content: '',
        embeds: [{
          color: COLOR.red,
          title: '⚠️ Invalid Target Channel',
          description: `Channel \`${newChannelId}\` is not a valid text channel.`,
        }],
      });
    }

    const controllerId = await ensureController(guildId, user, store, saveStore);

    let newCfgId = Math.random().toString(36).substring(2, 8);
    while (store.configs[newCfgId]) {
      newCfgId = Math.random().toString(36).substring(2, 8);
    }

    const clonedName = customName || sourceCfg.name;
    store.configs[newCfgId] = {
      userId: user.id,
      username: user.username,
      guildId,
      controllerChannelId: controllerId,
      cardMessageId: null,
      name: clonedName,
      channelId: newChannelId,
      text: sourceCfg.text,
      delay: sourceCfg.delay,
      running: false,
      startedAt: null,
      sent: 0,
      failed: 0,
      lastSentAt: null,
      lastError: null,
      createdAt: Date.now(),
    };

    await repostCards(guildId, user.id, controllerId);
    saveStore(store);

    await editOriginal(token, {
      content: '',
      embeds: [{
        color: COLOR.green,
        title: '✅ Pipeline Duplicated Successfully',
        description:
          `Cloned **\`${sourceCfg.name}\`** (\`${sourceId}\`) into **\`${clonedName}\`** (\`${newCfgId}\`).\n\n` +
          `📍 **New Target:** <#${newChannelId}>\n` +
          `⏱️ **Interval:** Every ${sourceCfg.delay}s\n` +
          `📂 **Command Center:** <#${controllerId}>\n` +
          `🔒 *Created in a paused state—press Execute on the card or run \`/start-staggered\` when ready.*`,
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    console.error('[ERROR] Failed to execute /duplicate-config:', err?.message || err);
    const errMsg =
      err?.code === 10003
        ? 'Target channel does not exist or your account lacks access to it.'
        : err?.message || 'Unknown error';
    await editOriginal(token, {
      content: '',
      embeds: [{ color: COLOR.red, title: '⚠️ Duplication Failed', description: `Details: \`${errMsg}\`.` }],
    }).catch(() => {});
  }
}

export async function handleAddConfig(req, res, ctx) {
  const { user, guildId, options, token, store, saveStore, mineOf, ensureController, repostCards, setupPanel, editOriginal } = ctx;
  const userTokens = Object.keys(store.credentials[user.id] || {});
  if (!userTokens.length) {
    return notice(
      res,
      COLOR.red,
      '🚫 Authorization Blocked',
      'Security policy requires a registered user credential before provisioning pipelines.\n\n👉 Run `/add-token register` first.'
    );
  }

  const cfgName = options?.[0]?.value?.trim()?.slice(0, 50);
  if (!cfgName) return ephemeral(res, '⚠️ Configuration name cannot be empty.');

  const maxConfigs = getMaxConfigs(user.id, store);
  const saved = mineOf(guildId, user.id).length;
  const open = Object.values(store.drafts || {}).filter((d) => d.userId === user.id && d.guildId === guildId).length;

  if (saved + open >= maxConfigs) {
    const limitStr = maxConfigs === Infinity ? 'Unlimited' : maxConfigs;
    const tierLabel = store.access[user.id]?.durationLabel || 'Free Trial';
    return notice(
      res,
      COLOR.red,
      '⚠️ Quota Exceeded',
      `Maximum limit of **${limitStr}** configuration(s) reached for your clearance tier (\`${tierLabel}\`).${
        maxConfigs !== Infinity ? '\n\n👉 *Upgrade your pass in the store channel to unlock more configuration slots!*' : ''
      }`
    );
  }

  if (open >= MAX_OPEN_SETUPS) {
    return notice(res, COLOR.red, '⚠️ Unfinished Setups', `Please complete or cancel your ${open} pending setup channels first.`);
  }

  try {
    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });

    store.users ??= {};
    let controllerId = store.users[`${guildId}:${user.id}`]?.controllerChannelId;
    if (!controllerId) {
      controllerId = await ensureController(guildId, user, store, saveStore);
      await repostCards(guildId, user.id, controllerId);
    }

    const randSuffix = Math.random().toString(36).substring(2, 6);
    const setupChannelName = `setup-${slug(cfgName)}-${randSuffix}`;

    const setup = await DiscordRequest(`guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: setupChannelName,
        type: 0,
        parent_id: process.env.USER_SETUP_ID,
        topic: '🔒 Secured setup channel. Self-destructs automatically in 10 minutes if unconfirmed.',
        permission_overwrites: privateOverwrites(guildId, user.id),
      },
    });

    const draft = {
      userId: user.id,
      username: user.username,
      guildId,
      name: cfgName,
      channelId: null,
      text: null,
      delay: null,
      createdAt: Date.now(),
    };
    store.drafts[setup.id] = draft;
    saveStore(store);

    const EXPIRATION_MS = 10 * 60 * 1000;
    setTimeout(async () => {
      if (store.drafts[setup.id]) {
        console.log(`[AUTOCLEAN] Setup workspace ${setup.id} timed out after 10m. Destroying...`);
        delete store.drafts[setup.id];
        saveStore(store);
        await DiscordRequest(`channels/${setup.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }, EXPIRATION_MS);

    await DiscordRequest(`channels/${setup.id}/messages`, {
      method: 'POST',
      body: {
        ...setupPanel(setup.id, draft),
        content: `<@${user.id}> Your pipeline setup environment is ready!`,
        allowed_mentions: { users: [user.id] },
      },
    });

    await editOriginal(token, {
      content: '',
      embeds: [{
        color: COLOR.green,
        title: '✅ Setup Environment Provisioned',
        description: `Proceed in <#${setup.id}> (Self-destructs in 10 mins).\nCommand Center: <#${controllerId}>`,
      }],
    });
  } catch (err) {
    console.error('[ERROR] Failed to execute /add-config:', err?.message || err);
    await editOriginal(token, {
      content: '',
      embeds: [{
        color: COLOR.red,
        title: '⚠️ Provisioning Failed',
        description: `Details: \`${err?.message || 'Unknown error'}\`. Verify bot channel creation permissions.`,
      }],
    }).catch(() => {});
  }
}