// handlers/commands/diagnostics.js
import { COLOR } from '../../config/constants.js';
import { reply } from '../../ui/primitives.js';
import { helpEmbed } from '../../ui/panels.js';
import { DiscordRequest } from '../../utils/discord.js';

export function handleHelp(res, ctx) {
  return reply(res, { embeds: [helpEmbed(ctx.trialDays)] });
}

export async function handleDiagnose(req, res, ctx) {
  const { user, guildId, store, mineOf, ADMIN_ID } = ctx;
  const mine = mineOf(guildId, user.id);
  const credEntries = Object.entries(store.credentials[user.id] || {});
  const hasToken = credEntries.length > 0;
  const tokenProfile = hasToken
    ? `${credEntries[0][0]} (\`${credEntries[0][1].redacted}\`)`
    : '❌ None registered';

  const access = store.access[user.id];
  let clearanceText = '❌ No active clearance';
  if (user.id === ADMIN_ID) {
    clearanceText = '🛡️ Administrator (Unlimited)';
  } else if (access) {
    clearanceText =
      access.expiresAt === 'permanent'
        ? `🟢 ${access.durationLabel} (Never expires)`
        : `🟢 ${access.durationLabel} (Expires <t:${Math.floor(access.expiresAt / 1000)}:R>)`;
  }

  const ctrlId = store.users?.[`${guildId}:${user.id}`]?.controllerChannelId;
  let ctrlStatus = '⚠️ Not initialized (Run `/controller`)';
  if (ctrlId) {
    try {
      await DiscordRequest(`channels/${ctrlId}`);
      ctrlStatus = `✅ Active (<#${ctrlId}>)`;
    } catch {
      ctrlStatus = '❌ Missing / Deleted in Discord (Run `/controller` to rebuild)';
    }
  }

  const runningConfigs = mine.filter(([, c]) => c.running);
  const errorConfigs = mine.filter(([, c]) => Boolean(c.lastError));
  const activeRollout = store.staggered?.[`${guildId}:${user.id}`];

  const fields = [
    { name: '🔐 Credential Vault', value: tokenProfile, inline: false },
    { name: '🛡️ Security Clearance', value: clearanceText, inline: true },
    { name: '📂 Command Center', value: ctrlStatus, inline: true },
    {
      name: '📊 Pipeline Summary',
      value: `Total: **${mine.length}** · Running: **${runningConfigs.length}** · Paused: **${mine.length - runningConfigs.length}** · With Errors: **${errorConfigs.length}**`,
      inline: false,
    },
  ];

  if (activeRollout && activeRollout.status === 'active') {
    const nextUnix = Math.floor((activeRollout.nextRunAt || Date.now()) / 1000);
    fields.push({
      name: '🚀 Staggered Rollout Status',
      value: `Active (**${activeRollout.currentRound}/${activeRollout.totalRounds}** launched, next <t:${nextUnix}:R>)`,
      inline: false,
    });
  }

  if (errorConfigs.length > 0) {
    const errorList = errorConfigs
      .slice(0, 6)
      .map(([cfgId, c]) => `• **${c.name}** (\`${cfgId}\`) — ${String(c.lastError).slice(0, 85)}`)
      .join('\n');
    const extra = errorConfigs.length > 6 ? `\n*...and ${errorConfigs.length - 6} more. Check your controller cards.*` : '';
    fields.push({
      name: '⚠️ Pipelines Reporting Errors',
      value: `${errorList}${extra}`,
      inline: false,
    });
  }

  return reply(res, {
    embeds: [{
      color: errorConfigs.length > 0 || !hasToken ? COLOR.amber : COLOR.green,
      title: '🩺 AutomateX System Diagnostics',
      description: hasToken
        ? 'Diagnostic snapshot of your session, controller channel, and pipeline health:'
        : '⚠️ **Action Needed:** Register a token with `/add-token register` before starting pipelines.',
      fields,
      footer: { text: 'AutomateX Diagnostics • Read-Only Check' },
      timestamp: new Date().toISOString(),
    }],
  });
}

export function handleStatus(req, res, ctx) {
  const { user, guildId, store, mineOf, ADMIN_ID } = ctx;
  const mine = mineOf(guildId, user.id);
  const hasToken = Boolean(Object.keys(store.credentials[user.id] || {}).length);
  const clearance = store.access[user.id] || (user.id === ADMIN_ID ? { durationLabel: 'Admin Overwrite' } : null);

  return reply(res, {
    embeds: [{
      color: COLOR.green,
      title: '🟢 System Telemetry & Status',
      fields: [
        { name: '🔒 Credential Vault', value: hasToken ? '✅ Provisioned' : '❌ Unregistered', inline: true },
        { name: '🛡️ Clearance', value: clearance ? clearance.durationLabel : '❌ Revoked', inline: true },
        { name: '⚡ Active Runners', value: String(mine.filter(([, c]) => c.running).length), inline: true },
      ],
    }],
  });
}

export async function handleController(req, res, ctx) {
  const { user, guildId, token, store, saveStore, ensureController, repostCards, editOriginal } = ctx;
  res.send({
    type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: { flags: 64 },
  });
  try {
    const controllerId = await ensureController(guildId, user, store, saveStore);
    const restored = await repostCards(guildId, user.id, controllerId);
    await editOriginal(token, {
      content:
        `📂 **Command Center Established**: <#${controllerId}>` +
        (restored ? `\n🔧 *Restored ${restored} missing telemetry card(s).*` : ''),
    });
  } catch {
    await editOriginal(token, {
      content: '⚠️ **Initialization Error**: Unable to open controller channel. Verify role permissions.',
    }).catch(() => {});
  }
}