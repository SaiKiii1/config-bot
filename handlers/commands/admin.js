// handlers/commands/admin.js
import { InteractionResponseType } from 'discord-interactions';
import { COLOR } from '../../config/constants.js';
import { ephemeral, notice } from '../../ui/primitives.js';
import { DiscordRequest, sendDM, manageRole } from '../../utils/discord.js';
import { stopRunner } from '../../services/runner.js';

export function handleSetTrialDuration(req, res, ctx) {
  const { user, options, store, saveStore, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const daysOpt = options.find((o) => o.name === 'days')?.value;
  if (!daysOpt || daysOpt <= 0) {
    return ephemeral(res, '⚠️ Please provide a valid number of days greater than 0.');
  }

  store.settings.trialDurationDays = daysOpt;
  saveStore(store);

  return notice(res, COLOR.green, '✅ Trial Duration Updated', `New free trial duration has been successfully set to **${daysOpt} day(s)**.`);
}

export function handleSetPrice(req, res, ctx) {
  const { user, options, store, saveStore, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const lifetimeOpt = options.find((o) => o.name === 'lifetime_dl')?.value;
  if (lifetimeOpt === undefined || lifetimeOpt < 0) {
    return ephemeral(res, '⚠️ Please provide a valid Diamond Lock (DL) amount for Lifetime access.');
  }

  store.settings.lifetimePrice = lifetimeOpt;
  saveStore(store);

  const auto3d = Math.max(1, Math.round(lifetimeOpt * 0.1));
  const auto7d = Math.max(1, Math.round(lifetimeOpt * 0.2));
  const auto1m = Math.max(1, Math.round(lifetimeOpt * 0.5));

  return notice(
    res,
    COLOR.green,
    '💎 Base Price Updated & Proportions Scaled',
    `Lifetime price successfully set to **${lifetimeOpt} DLs**.\n\nShorter tiers have automatically scaled:\n• **3 Days:** ${auto3d} DLs\n• **7 Days:** ${auto7d} DLs\n• **1 Month:** ${auto1m} DLs\n• **Lifetime:** ${lifetimeOpt} DLs`
  );
}

export function handleStore(req, res, ctx) {
  const { user, ADMIN_ID, trialDays, prices } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const { d3, d7, d1m, dLife } = prices;

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [{
        color: COLOR.blurple,
        title: '⚡ AUTOMATEX — 24/7 AUTOMATED DISCORD AUTO-POST SERVICE',
        description: 'Boost your server reach, traffic, and sales automatically 24/7 non-stop across targeted Discord channels!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        fields: [
          {
            name: '💎 OFFICIAL LICENSE PRICING',
            value:
              '```text\n' +
              'Package    Price (PHP/USD)   Diamond Locks   Configs\n' +
              '───────────────────────────────────────────────────────\n' +
              `🎁 Free    FREE ($0.00)      0 DLs (${trialDays}d)     5 Slots\n` +
              `🥉 3 Days  ₱30 (~$0.55)      ${d3} DLs${d3 < 10 ? ' ' : ''}         10 Slots\n` +
              `🥈 7 Days  ₱60 (~$1.05)      ${d7} DLs${d7 < 10 ? ' ' : ''}         25 Slots\n` +
              `🥇 1 Month ₱150 (~$2.60)     ${d1m} DLs${d1m < 10 ? ' ' : ''}         50 Slots\n` +
              `👑 Lifetime ₱300 (~$5.20)    ${dLife} DLs${dLife < 10 ? ' ' : ''}        Unlimited\n` +
              '```',
            inline: false,
          },
          {
            name: '💳 ACCEPTED PAYMENT METHODS',
            value: '• 🇵🇭 **GCash**\n• 🅿️ **PayPal**\n• 💸 **Wise**\n• 💎 **Growtopia Diamond Locks (DLs)**\n\n📌 *Please open a ticket below to complete your payment and request instant authorization.*',
            inline: false,
          },
        ],
        footer: { text: 'AutomateX Store • Official Licensing & Pricing' },
        timestamp: new Date().toISOString(),
      }],
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: 'store_select_package',
              placeholder: '💳 Click here to view package details...',
              options: [
                { label: '3 Days Pass', value: 'pkg_3d', description: `₱30 (~$0.55 USD) / ${d3} DLs • 10 Config Slots`, emoji: { name: '🥉' } },
                { label: '7 Days Pass', value: 'pkg_7d', description: `₱60 (~$1.05 USD) / ${d7} DLs • 25 Config Slots`, emoji: { name: '🥈' } },
                { label: '1 Month Pass', value: 'pkg_1m', description: `₱150 (~$2.60 USD) / ${d1m} DLs • 50 Config Slots`, emoji: { name: '🥇' } },
                { label: 'Lifetime Pass', value: 'pkg_lifetime', description: `₱300 (~$5.20 USD) / ${dLife} DLs • Unlimited Configs`, emoji: { name: '👑' } },
              ],
            },
          ],
        },
        {
          type: 1,
          components: [
            { type: 2, custom_id: 'store_free_trial', label: `🎁 Free Trial (${trialDays}d)`, style: 3 },
            { type: 2, custom_id: 'store_guide', label: '📖 Guide (EN)', style: 2 },
            { type: 2, custom_id: 'store_features', label: '⚡ Core Features', style: 2 },
          ],
        },
      ],
    },
  });
}

export function handleCheckAccess(req, res, ctx) {
  const { user, options, store, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const targetUser = options.find((o) => o.name === 'target')?.value || options.find((o) => o.name === 'user')?.value;
  const accessRecord = store.access[targetUser];

  if (!accessRecord) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `❌ <@${targetUser}> has **no active access** or subscription record on AutomateX.`,
        flags: 64,
      },
    });
  }

  const startTimestamp = Math.floor(new Date(accessRecord.grantedAt).getTime() / 1000);
  const expireTimestamp =
    accessRecord.expiresAt === 'permanent' ? null : Math.floor(new Date(accessRecord.expiresAt).getTime() / 1000);
  const isExpired = accessRecord.expiresAt !== 'permanent' && Date.now() > new Date(accessRecord.expiresAt).getTime();

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [{
        color: isExpired ? COLOR.red : COLOR.green,
        title: '🛡️ Access Status Verification',
        description: `Access clearance details for <@${targetUser}>`,
        fields: [
          { name: '📊 Status', value: isExpired ? '🔴 **Expired**' : '🟢 **Active Clearance**', inline: true },
          { name: '⏳ Duration', value: `\`${accessRecord.durationLabel}\``, inline: true },
          { name: '📅 Started At', value: `<t:${startTimestamp}:F> (<t:${startTimestamp}:R>)`, inline: false },
          {
            name: '⏰ Expires At',
            value: expireTimestamp ? `<t:${expireTimestamp}:F> (<t:${expireTimestamp}:R>)` : '♾️ **Permanent / Never**',
            inline: false,
          },
        ],
        footer: { text: 'AutomateX Security & Access Management' },
      }],
      flags: 64,
    },
  });
}

export function handlePromotion(req, res, ctx) {
  const { user, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: '@everyone',
      embeds: [{
        color: COLOR.blurple,
        title: '🚀 AUTOMATEX IS NOW LIVE 🚀',
        description:
          'Welcome to **AutomateX**!\n\nThe ultimate enterprise-grade Discord automation framework. We provide intelligent, humanized dispatch systems to keep your accounts secure and your workflow efficient.',
        fields: [
          { name: '🛡️ ANTI-BAN TELEMETRY', value: 'Humanized jitter, typing indicators, and read acknowledgments.', inline: true },
          { name: '⚡ SMART PRE-FLIGHT', value: 'Prevents duplicate message spam to protect your account standing.', inline: true },
          { name: '🔐 SECURE VAULT', value: 'AES-256-GCM encrypted token storage for maximum safety.', inline: true },
          { name: '⏱️ DYNAMIC CADENCE', value: 'Fully customizable delays, controller panels, and deployment pipelines.', inline: true },
          {
            name: '📌 HOW TO GET STARTED',
            value:
              '1. Head over to our store channel and claim your free trial pass.\n2. Once verified by our staff or system, your access will be granted.\n3. Run `/add-token register` to securely vault your account.\n4. Provision your pipeline using `/add-config`.\n5. Manage your active posts in your private Command Center.',
            inline: false,
          },
        ],
        footer: { text: '🔒 AutomateX • Secure. Automated. Reliable.' },
      }],
    },
  });
}

export async function handleGrantAccess(req, res, ctx) {
  const { user, guildId, options, store, saveStore, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const targetUser = options.find((o) => o.name === 'user').value;
  const duration = options.find((o) => o.name === 'duration').value;

  let expiresAt;
  let label;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  switch (duration) {
    case '24h': expiresAt = now + DAY; label = '24 Hours'; break;
    case '3d': expiresAt = now + 3 * DAY; label = '3 Days'; break;
    case '7d': expiresAt = now + 7 * DAY; label = '7 Days'; break;
    case '1w': expiresAt = now + 7 * DAY; label = '1 Week'; break;
    case '1m': expiresAt = now + 30 * DAY; label = '1 Month'; break;
    case 'lifetime': expiresAt = 'permanent'; label = 'Lifetime Pass'; break;
    case 'perm': expiresAt = 'permanent'; label = 'Permanent'; break;
  }

  store.access[targetUser] = { grantedAt: now, expiresAt, durationLabel: label };
  saveStore(store);

  await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'PUT').catch(() => {});
  await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'DELETE').catch(() => {});

  await sendDM(targetUser, {
    embeds: [{
      color: COLOR.green,
      title: '🟢 SUBSCRIPTION ACCESS GRANTED',
      description: `Hello <@${targetUser}>! Your AutomateX subscription access has been activated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Duration:** ${label}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`,
    }],
  }).catch(() => {});

  return notice(res, COLOR.green, '✅ Clearance Granted', `Operator <@${targetUser}> has been authorized.\n**Duration:** ${label}`);
}

export async function handleExtendAccess(req, res, ctx) {
  const { user, guildId, options, store, saveStore, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const targetUser = options.find((o) => o.name === 'user').value;
  const duration = options.find((o) => o.name === 'duration').value;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const existing = store.access[targetUser];

  if (duration === 'perm') {
    store.access[targetUser] = {
      grantedAt: existing?.grantedAt || now,
      expiresAt: 'permanent',
      durationLabel: 'Permanent',
    };
    saveStore(store);

    await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'PUT').catch(() => {});
    await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'DELETE').catch(() => {});

    await sendDM(targetUser, {
      embeds: [{
        color: COLOR.green,
        title: '👑 SUBSCRIPTION UPGRADED TO PERMANENT',
        description: `Hello <@${targetUser}>! Your AutomateX clearance has been upgraded to **Permanent** access with all existing configurations preserved.`,
      }],
    }).catch(() => {});

    return notice(res, COLOR.green, '👑 Clearance Upgraded', `Operator <@${targetUser}> is now authorized for **Permanent** access.`);
  }

  let addMs = DAY;
  let addLabel = '24 Hours';
  switch (duration) {
    case '24h': addMs = DAY; addLabel = '24 Hours'; break;
    case '3d': addMs = 3 * DAY; addLabel = '3 Days'; break;
    case '7d': addMs = 7 * DAY; addLabel = '7 Days'; break;
    case '1w': addMs = 7 * DAY; addLabel = '1 Week'; break;
    case '1m': addMs = 30 * DAY; addLabel = '1 Month'; break;
  }

  if (existing?.expiresAt === 'permanent') {
    return ephemeral(res, `ℹ️ <@${targetUser}> already has **Permanent** clearance.`);
  }

  const baseTime = existing && existing.expiresAt > now ? existing.expiresAt : now;
  const newExpiresAt = baseTime + addMs;
  const newLabel =
    existing && existing.expiresAt > now ? `${existing.durationLabel} (+${addLabel})` : addLabel;

  store.access[targetUser] = {
    grantedAt: existing?.grantedAt || now,
    expiresAt: newExpiresAt,
    durationLabel: newLabel,
    warned24h: false,
  };
  saveStore(store);

  await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'PUT').catch(() => {});
  await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'DELETE').catch(() => {});

  const expireUnix = Math.floor(newExpiresAt / 1000);
  await sendDM(targetUser, {
    embeds: [{
      color: COLOR.green,
      title: '⏳ SUBSCRIPTION ACCESS EXTENDED',
      description: `Hello <@${targetUser}>! Your AutomateX subscription has been extended by **${addLabel}**.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**New Expiration:** <t:${expireUnix}:F> (<t:${expireUnix}:R>)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*All existing tokens and pipelines remain intact.*`,
    }],
  }).catch(() => {});

  return notice(
    res,
    COLOR.green,
    '⏳ Clearance Extended',
    `Extended <@${targetUser}> by **${addLabel}**.\n**New Expiration:** <t:${expireUnix}:F> (<t:${expireUnix}:R>)`
  );
}

export async function handleRevokeAccess(req, res, ctx) {
  const { user, guildId, options, store, saveStore, ADMIN_ID } = ctx;
  if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

  const targetUser = options.find((o) => o.name === 'user').value;
  const reasonOpt = options.find((o) => o.name === 'reason');
  const reason = reasonOpt ? reasonOpt.value : 'Access revoked by the Administrator.';

  delete store.access[targetUser];
  delete store.credentials[targetUser];

  let terminated = 0;
  for (const [id, c] of Object.entries(store.configs)) {
    if (c.userId === targetUser) {
      if (c.running) stopRunner(id, store);
      DiscordRequest(`channels/${c.controllerChannelId}/messages/${c.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
      delete store.configs[id];
      terminated++;
    }
  }
  saveStore(store);

  await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'DELETE').catch(() => {});
  await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'PUT').catch(() => {});

  await sendDM(targetUser, {
    embeds: [{
      color: COLOR.red,
      title: '🔴 SUBSCRIPTION ACCESS REVOKED',
      description: `Hello <@${targetUser}>! Your AutomateX subscription access has been deactivated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Reason:** ${reason}\n**Security Action:** All your account token data, posting configurations, and controller channels have been cleared from the database.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Security Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`,
    }],
  }).catch(() => {});

  return notice(
    res,
    COLOR.green,
    '🗑️ Operator Purged',
    `Operator <@${targetUser}> authorization terminated.\n🛑 **${terminated} pipeline(s) destroyed and credential vault wiped.**`
  );
}