// handlers/commands.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, slug, privateOverwrites, redactToken, sendDM, manageRole } from '../utils.js';
import {
  stopAllRunnersForUser,
  stopRunner,
  startRunner,
  startStaggeredRollout,
  cancelStaggeredRollout,
} from '../services/runner.js';

const COLOR = { blurple: 0x5865f2, green: 0x57f287, amber: 0xfee75c, red: 0xed4245 };
const MAX_OPEN_SETUPS = 3;

const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...data },
  });
const ephemeral = (res, content) => reply(res, { content });
const notice = (res, color, title, description) => reply(res, { embeds: [{ color, title, description }] });

function getMaxConfigs(userId, store) {
  const ADMIN_ID = process.env.ADMIN_ID;
  if (userId === ADMIN_ID) return Infinity;

  const access = store.access?.[userId];
  if (!access) return 5;

  if (access.expiresAt === 'permanent') return Infinity;

  const label = access.durationLabel || '';
  if (label.includes('Permanent') || label.includes('Lifetime')) return Infinity;
  if (label.includes('1 Month')) return 50;
  if (label.includes('7 Days') || label.includes('1 Week')) return 25;
  if (label.includes('3 Days')) return 10;
  if (label.includes('Free Trial') || label.includes('24 Hours') || label.includes('Days (Free Trial)')) return 5;

  return 5;
}

const helpEmbed = (trialDays = 7) => ({
  color: 0x5865f2,
  title: '🛡️ AutomateX — Command Center & Guide',
  description: 'Enterprise-grade Discord automation framework featuring humanized dispatch and secure credential vaulting.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your single account token securely.\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline workspace.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and manage active dispatches.',
    },
    {
      name: '⚙️ Core User Commands',
      value:
        '• **`/help`** — Display this documentation and system guide.\n' +
        '• **`/status`** — View your system telemetry, credential status, and clearance.\n' +
        '• **`/list-configs`** — See all of your active and saved configuration pipelines.\n' +
        '• **`/delete-all-configs`** — Permanently purge all of your configuration pipelines and controller cards.\n' +
        '• **`/controller`** — Open or restore your private secured Command Center channel.\n' +
        '• **`/stop-all`** — Emergency halt all of your running configuration pipelines at once.\n' +
        '• **`/start-staggered`** — Safely launch all paused configuration pipelines in random or top-to-bottom order with a custom delay gap.\n' +
        '• **`/cancel-staggered`** — Abort an in-progress staggered pipeline rollout immediately.\n' +
        '• **`/add-token`** — Register, list, or purge your account session credentials.\n' +
        '• **`/add-config`** — Create a new automated posting configuration.\n' +
        '• **`/allow-copy-config`** — Toggle your controller template sharing status on/off.\n' +
        '• **`/copy-controller`** — Mirror another operator\'s shared controller pipelines.',
    },
    {
      name: '🔑 Administration & Management Tools',
      value:
        '• **`/store`** — Publish the official AutomateX license pricing and store showcase embed *(Admin)*.\n' +
        '• **`/set-trial-duration`** — Configure the active free trial duration in days *(Admin)*.\n' +
        '• **`/set-price`** — Configure the base Lifetime Diamond Lock price *(Admin)*.\n' +
        '• **`/check-access`** — Verify subscription clearance and expiration status of a user *(Admin)*.\n' +
        '• **`/grant-access`** — Authorize a user with a specific subscription duration tier *(Admin)*.\n' +
        '• **`/revoke-access`** — Terminate clearance, purge credentials, and wipe user pipelines *(Admin)*.\n' +
        '• **`/promotion`** — Broadcast the official AutomateX launch and setup announcement embed *(Admin)*.\n' +
        '• **`/terms-of-service`** — Publish the official legal terms of service embed *(Admin)*.',
    },
    {
      name: '🧭 Server Guide & Channels',
      value:
        '• <#1567854828670025748> — Review our legal policies, safety heuristics, and terms of service.\n' +
        '• <#1567187360733601833> — Read community guidelines and core server rules.\n' +
        '• <#1567211746953797743> — Stay updated with official system updates and announcements.\n' +
        '• <#1567212596061540552> — A dedicated space to chat, converse, and hang out with other members.\n' +
        '• <#1567212628386783242> — The recommended channel for executing bot and slash commands.',
    },
  ],
  footer: { text: `AutomateX • Current Trial Duration: ${trialDays} Days` },
  timestamp: new Date().toISOString()
});

export function credentialInputModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'modal:add-token:save',
      title: '🔐 Secure Credential Registration (Limit: 1)',
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'label_name', label: 'Token Profile Label', style: 1, required: true, max_length: 50, placeholder: 'e.g., My-Primary-Account' }] },
        { type: 1, components: [{ type: 4, custom_id: 'token_value', label: 'Discord Account Session Token', style: 1, required: true, min_length: 50, max_length: 200, placeholder: 'Paste session credential (encrypted at rest)' }] }
      ],
    },
  };
}

export async function handleCommand(req, res, store, saveStore, mineOf, ensureController, repostCards, editOriginal, setupPanel, btn, row, refreshCard) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;
  const { name } = data;
  const options = data.options ?? [];
  
  const ADMIN_ID = process.env.ADMIN_ID;

  store.settings ??= {};
  store.settings.trialDurationDays ??= 7;
  store.settings.lifetimePrice ??= 100; // Default lifetime price in DLs
  const trialDays = store.settings.trialDurationDays;
  const lifetimePrice = store.settings.lifetimePrice;

  // Automatically derive proportional tier prices from Lifetime price
  const dLife = lifetimePrice;
  const d1m = Math.max(1, Math.round(lifetimePrice * 0.5));   // 50% of Lifetime
  const d7 = Math.max(1, Math.round(lifetimePrice * 0.2));    // 20% of Lifetime
  const d3 = Math.max(1, Math.round(lifetimePrice * 0.1));    // 10% of Lifetime

  if (name === 'help') return reply(res, { embeds: [helpEmbed(trialDays)] });
  if (!guildId) return ephemeral(res, '⚠️ **Context Error**: Command execution restricted to guild servers.');

  const adminCommands = ['grant-access', 'revoke-access', 'promotion', 'store', 'set-trial-duration', 'set-price'];
  if (!adminCommands.includes(name) && name !== 'copy-controller' && name !== 'allow-copy-config') {
    const access = store.access[user.id];
    const now = Date.now();
    
    if (user.id !== ADMIN_ID) {
      if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
        if (access) {
          delete store.access[user.id];
          saveStore(store);
        }
        return notice(res, COLOR.red, '🚫 Clearance Required', 'You do not have active security clearance to operate this framework. Please contact the administrator.');
      }
    }
  }

  // --- ALLOW CONFIG COPY COMMAND (USER OPT-IN) ---
  if (name === 'allow-copy-config') {
    store.users ??= {};
    store.users[`${guildId}:${user.id}`] ??= {};
    
    const currentState = store.users[`${guildId}:${user.id}`].shareable ?? false;
    const newState = !currentState;
    store.users[`${guildId}:${user.id}`].shareable = newState;
    saveStore(store);

    const controllerId = store.users[`${guildId}:${user.id}`].controllerChannelId;

    if (newState && controllerId) {
      await DiscordRequest(`channels/${controllerId}/messages`, {
        method: 'POST',
        body: {
          embeds: [{
            color: COLOR.green,
            title: '🟢 TEMPLATE SHARING ACTIVE',
            description: 'Your controller templates are now **shareable**. Other operators can mirror your configuration pipelines using `/copy-controller`.\n\nClick the button below instantly to revoke sharing access at any time.',
            timestamp: new Date().toISOString()
          }],
          components: [
            row(btn('share:disable', '🛑 Stop Sharing Templates', 4))
          ]
        }
      }).catch(() => {});
    }

    return notice(
      res,
      newState ? COLOR.green : COLOR.amber,
      newState ? '🟢 Template Sharing Enabled' : '🔴 Template Sharing Disabled',
      newState 
        ? 'Your configurations are now open for copying. An interactive control prompt has been sent to your Command Center channel.'
        : 'Your template sharing has been deactivated. Other operators can no longer mirror your setup.'
    );
  }

  // --- COPY CONTROLLER COMMAND ---
  if (name === 'copy-controller') {
    const sourceUser = options.find((o) => o.name === 'source')?.value;
    const targetUser = options.find((o) => o.name === 'target')?.value || user.id;

    if (!sourceUser) {
      return ephemeral(res, '⚠️ Please provide the `source` operator whose controller you want to copy.');
    }

    if (sourceUser === targetUser) {
      return ephemeral(res, '⚠️ Source and target operator cannot be the same.');
    }

    store.users ??= {};
    const sourceUserData = store.users[`${guildId}:${sourceUser}`];
    const isSourceShareable = sourceUserData?.shareable ?? false;

    if (user.id !== ADMIN_ID && !isSourceShareable) {
      return notice(
        res,
        COLOR.red,
        '🚫 Sharing Restricted',
        `Operator <@${sourceUser}> has not made their controller templates shareable. They must run \`/allow-copy-config\` first to permit mirroring.`
      );
    }

    const sourceConfigs = Object.entries(store.configs || {}).filter(
      ([, c]) => c.userId === sourceUser && c.guildId === guildId
    );

    if (!sourceConfigs.length) {
      return notice(res, COLOR.amber, '📭 Zero Source Pipelines', `Operator <@${sourceUser}> has no active configuration pipelines to copy.`);
    }

    const targetMaxConfigs = getMaxConfigs(targetUser, store);
    const targetExistingCount = mineOf(guildId, targetUser).length;

    if (targetExistingCount + sourceConfigs.length > targetMaxConfigs) {
      const limitStr = targetMaxConfigs === Infinity ? 'Unlimited' : targetMaxConfigs;
      return notice(
        res,
        COLOR.red,
        '⚠️ Quota Exceeded for Target',
        `Cannot copy controller. Target operator <@${targetUser}> has **${targetExistingCount}** existing config(s) and requires **${sourceConfigs.length}** slot(s), exceeding their tier maximum limit of **${limitStr}**.`
      );
    }

    try {
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });

      let targetControllerId = store.users[`${guildId}:${targetUser}`]?.controllerChannelId;
      
      if (!targetControllerId) {
        const targetUserObj = { id: targetUser, username: 'TargetOperator' };
        targetControllerId = await ensureController(guildId, targetUserObj, store, saveStore);
      }

      let clonedCount = 0;
      for (const [, cfg] of sourceConfigs) {
        const newCfgId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        
        store.configs[newCfgId] = {
          userId: targetUser,
          username: 'TargetOperator',
          guildId: guildId,
          controllerChannelId: targetControllerId,
          cardMessageId: null,
          name: cfg.name,
          channelId: cfg.channelId,
          text: cfg.text,
          delay: cfg.delay,
          running: false,
          startedAt: null,
          sent: 0,
          failed: 0,
          lastSentAt: null,
          lastError: null,
          createdAt: Date.now()
        };
        clonedCount++;
      }

      await repostCards(guildId, targetUser, targetControllerId);
      saveStore(store);

      await editOriginal(token, {
        content: '',
        embeds: [{
          color: COLOR.green,
          title: '✅ Controller Cloned Successfully',
          description: `Successfully mirrored **${clonedCount}** configuration pipeline(s) from <@${sourceUser}> to <@${targetUser}>.\n\n📂 **Target Command Center:** <#${targetControllerId}>\n🔒 *Note: All cloned pipelines default to a paused state for safety.*`,
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      console.error('[ERROR] Failed to execute /copy-controller:', err?.message || err);
      await editOriginal(token, {
        content: '',
        embeds: [{ color: COLOR.red, title: '⚠️ Controller Copy Failed', description: `Details: \`${err?.message || 'Unknown error'}\`.` }]
      }).catch(() => {});
    }
    return;
  }

  // --- SET TRIAL DURATION COMMAND (ADMIN ONLY) ---
  if (name === 'set-trial-duration') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    
    const daysOpt = options.find((o) => o.name === 'days')?.value;
    if (!daysOpt || daysOpt <= 0) {
      return ephemeral(res, '⚠️ Please provide a valid number of days greater than 0.');
    }

    store.settings.trialDurationDays = daysOpt;
    saveStore(store);

    return notice(res, COLOR.green, '✅ Trial Duration Updated', `New free trial duration has been successfully set to **${daysOpt} day(s)**.`);
  }

  // --- SET PRICE COMMAND (ADMIN ONLY) ---
  if (name === 'set-price') {
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

  // --- STORE DISPLAY COMMAND (ADMIN ONLY) ---
  if (name === 'store') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');

    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [{
          color: 0x5865f2,
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
              inline: false
            },
            {
              name: '💳 ACCEPTED PAYMENT METHODS',
              value: '• 🇵🇭 **GCash**\n• 🅿️ **PayPal**\n• 💸 **Wise**\n• 💎 **Growtopia Diamond Locks (DLs)**\n\n📌 *Please open a ticket below to complete your payment and request instant authorization.*',
              inline: false
            }
          ],
          footer: { text: 'AutomateX Store • Official Licensing & Pricing' },
          timestamp: new Date().toISOString()
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
                  { label: 'Lifetime Pass', value: 'pkg_lifetime', description: `₱300 (~$5.20 USD) / ${dLife} DLs • Unlimited Configs`, emoji: { name: '👑' } }
                ]
              }
            ]
          },
          {
            type: 1,
            components: [
              { type: 2, custom_id: 'store_free_trial', label: `🎁 Free Trial (${trialDays}d)`, style: 3 },
              { type: 2, custom_id: 'store_guide', label: '📖 Guide (EN)', style: 2 },
              { type: 2, custom_id: 'store_features', label: '⚡ Core Features', style: 2 }
            ]
          }
        ]
      }
    });
  }

  // --- CHECK ACCESS (ADMIN ONLY) ---
  if (name === 'check-access') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    const targetUser = options.find(o => o.name === 'target')?.value || options.find(o => o.name === 'user')?.value;
    const accessRecord = store.access[targetUser];

    if (!accessRecord) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `❌ <@${targetUser}> has **no active access** or subscription record on AutomateX.`,
          flags: 64
        }
      });
    }

    const startTimestamp = Math.floor(new Date(accessRecord.grantedAt).getTime() / 1000);
    const expireTimestamp = accessRecord.expiresAt === 'permanent' ? null : Math.floor(new Date(accessRecord.expiresAt).getTime() / 1000);
    const isExpired = accessRecord.expiresAt !== 'permanent' && Date.now() > new Date(accessRecord.expiresAt).getTime();

    const embed = {
      color: isExpired ? COLOR.red : COLOR.green,
      title: `🛡️ Access Status Verification`,
      description: `Access clearance details for <@${targetUser}>`,
      fields: [
        { name: '📊 Status', value: isExpired ? '🔴 **Expired**' : '🟢 **Active Clearance**', inline: true },
        { name: '⏳ Duration', value: `\`${accessRecord.durationLabel}\``, inline: true },
        { name: '📅 Started At', value: `<t:${startTimestamp}:F> (<t:${startTimestamp}:R>)`, inline: false },
        { name: '⏰ Expires At', value: expireTimestamp ? `<t:${expireTimestamp}:F> (<t:${expireTimestamp}:R>)` : '♾️ **Permanent / Never**', inline: false }
      ],
      footer: {
        text: 'AutomateX Security & Access Management'
      }
    };

    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [embed],
        flags: 64
      }
    });
  }

  // --- PROMOTIONAL POST (ADMIN ONLY) ---
  if (name === 'promotion') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: '@everyone',
        embeds: [{
          color: 0x5865f2,
          title: '🚀 AUTOMATEX IS NOW LIVE 🚀',
          description: 'Welcome to **AutomateX**!\n\nThe ultimate enterprise-grade Discord automation framework. We provide intelligent, humanized dispatch systems to keep your accounts secure and your workflow efficient.',
          fields: [
            {
              name: '🛡️ ANTI-BAN TELEMETRY',
              value: 'Humanized jitter, typing indicators, and read acknowledgments.',
              inline: true
            },
            {
              name: '⚡ SMART PRE-FLIGHT',
              value: 'Prevents duplicate message spam to protect your account standing.',
              inline: true
            },
            {
              name: '🔐 SECURE VAULT',
              value: 'AES-256-GCM encrypted token storage for maximum safety.',
              inline: true
            },
            {
              name: '⏱️ DYNAMIC CADENCE',
              value: 'Fully customizable delays, controller panels, and deployment pipelines.',
              inline: true
            },
            {
              name: '📌 HOW TO GET STARTED',
              value: '1. Head over to our store channel and claim your free trial pass.\n2. Once verified by our staff or system, your access will be granted.\n3. Run `/add-token register` to securely vault your account.\n4. Provision your pipeline using `/add-config`.\n5. Manage your active posts in your private Command Center.',
              inline: false
            }
          ],
          footer: {
            text: '🔒 AutomateX • Secure. Automated. Reliable.'
          }
        }]
      }
    });
  }

  // --- ACCESS MANAGEMENT (ADMIN ONLY) ---
  if (name === 'grant-access') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    const targetUser = options.find(o => o.name === 'user').value;
    const duration = options.find(o => o.name === 'duration').value;
    
    let expiresAt;
    let label;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    
    switch(duration) {
      case '24h': expiresAt = now + DAY; label = '24 Hours'; break;
      case '3d': expiresAt = now + (3 * DAY); label = '3 Days'; break;
      case '7d': expiresAt = now + (7 * DAY); label = '7 Days'; break;
      case '1w': expiresAt = now + (7 * DAY); label = '1 Week'; break;
      case '1m': expiresAt = now + (30 * DAY); label = '1 Month'; break;
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
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been activated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Duration:** ${label}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    }).catch(() => {});

    return notice(res, COLOR.green, '✅ Clearance Granted', `Operator <@${targetUser}> has been authorized.\n**Duration:** ${label}`);
  }

  if (name === 'revoke-access') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    const targetUser = options.find(o => o.name === 'user').value;
    const reasonOpt = options.find(o => o.name === 'reason');
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
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been deactivated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Reason:** ${reason}\n**Security Action:** All your account token data, posting configurations, and controller channels have been cleared from the database.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Security Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    }).catch(() => {});

    return notice(res, COLOR.green, '🗑️ Operator Purged', `Operator <@${targetUser}> authorization terminated.\n🛑 **${terminated} pipeline(s) destroyed and credential vault wiped.**`);
  }

  // --- STANDARD COMMANDS ---
  if (name === 'add-token') {
    const actionOption = options.find((o) => o.name === 'action')?.value;

    if (actionOption === 'register') {
      const existingTokens = Object.keys(store.credentials[user.id] || {});
      if (existingTokens.length >= 1) {
        return notice(
          res, COLOR.amber, '⚠️ Token Limit Reached',
          `Your account is restricted to a maximum of **1** registered user token.\n\nCurrently registered profile: \`${existingTokens[0]}\`\n\nUse \`/add-token remove\` if you wish to purge and replace it.`
        );
      }
      return res.send(credentialInputModal());
    }

    if (actionOption === 'list') {
      const userCreds = Object.entries(store.credentials[user.id] || {});
      if (!userCreds.length) {
        return notice(res, COLOR.amber, '⚠️ No Credentials Found', 'Your security profile has no registered tokens.\n\nExecute `/add-token register` to begin.');
      }
      const fields = userCreds.map(([label, cred]) => ({
        name: `🏷️ Profile: ${label}`,
        value: `Registered: <t:${Math.floor(cred.createdAt / 1000)}:R>\nFingerprint: \`${cred.redacted}\``,
      }));
      return reply(res, { embeds: [{ color: COLOR.blurple, title: '🔐 Vault: Registered Credentials (Limit 1/1)', fields }] });
    }

    if (actionOption === 'remove') {
      const userCreds = Object.keys(store.credentials[user.id] || {});
      if (!userCreds.length) return ephemeral(res, '⚠️ Vault is currently empty. No credentials to purge.');
      return reply(res, {
        content: '🗑️ **Security Vault Purge**: Select credential profile to permanently remove:',
        components: [row(...userCreds.slice(0, 5).map((label) => btn(`cred:remove:${label}`, `Purge: ${label}`, 4)))],
      });
    }
  }

  if (name === 'status') {
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

  if (name === 'list-configs') {
    const mine = mineOf(guildId, user.id);
    if (!mine.length) return notice(res, COLOR.blurple, '📭 Zero Pipelines Active', 'Run `/add-config` to provision your first automation channel.');
    const ctrl = store.users[`${guildId}:${user.id}`]?.controllerChannelId;
    const maxConfigs = getMaxConfigs(user.id, store);
    const limitLabel = maxConfigs === Infinity ? '∞' : maxConfigs;

    return reply(res, {
      embeds: [{
        color: COLOR.blurple,
        title: `📋 Configuration Registry (${mine.length}/${limitLabel})`,
        description: ctrl ? `Manage active pipelines in <#${ctrl}>.` : undefined,
        fields: mine.map(([, c]) => ({
          name: `${c.running ? '🟢' : '🔴'} ${c.name.slice(0, 200)}`,
          value: `Dest: <#${c.channelId}> · Dispatches: \`${c.sent ?? 0}\``,
        })),
      }],
    });
  }

  if (name === 'delete-all-configs') {
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
          )
        ]
      }
    });
  }

  if (name === 'controller') {
    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
    try {
      const controllerId = await ensureController(guildId, user, store, saveStore);
      const restored = await repostCards(guildId, user.id, controllerId);
      await editOriginal(token, {
        content: `📂 **Command Center Established**: <#${controllerId}>` + (restored ? `\n🔧 *Restored ${restored} missing telemetry card(s).*` : ''),
      });
    } catch (err) {
      await editOriginal(token, { content: '⚠️ **Initialization Error**: Unable to open controller channel. Verify role permissions.' }).catch(() => {});
    }
    return;
  }

  if (name === 'stop-all') {
    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });

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
    return;
  }

  // --- /start-staggered COMMAND (PERSISTED TO STORE WITH ORDER CHOICE) ---
  if (name === 'start-staggered') {
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

  // --- /cancel-staggered COMMAND ---
  if (name === 'cancel-staggered') {
    const cancelled = cancelStaggeredRollout(guildId, user.id, store, saveStore);

    if (!cancelled) {
      return ephemeral(res, 'ℹ️ You do not have an active `/start-staggered` rollout in progress.');
    }

    return reply(res, {
      content: `🛑 **Staggered Rollout Cancelled**: Stopped launching remaining pipelines (**${cancelled.currentRound}/${cancelled.totalRounds}** already activated).\n*Note: Already-started pipelines will keep running. Use \`/stop-all\` to pause them.*`
    });
  }

  if (name === 'add-config') {
    const userTokens = Object.keys(store.credentials[user.id] || {});
    if (!userTokens.length) {
      return notice(res, COLOR.red, '🚫 Authorization Blocked', 'Security policy requires a registered user credential before provisioning pipelines.\n\n👉 Run `/add-token register` first.');
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

    if (open >= MAX_OPEN_SETUPS) return notice(res, COLOR.red, '⚠️ Unfinished Setups', `Please complete or cancel your ${open} pending setup channels first.`);

    try {
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });

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

      const draft = { userId: user.id, username: user.username, guildId, name: cfgName, channelId: null, text: null, delay: null, createdAt: Date.now() };
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
        body: { ...setupPanel(setup.id, draft), content: `<@${user.id}> Your pipeline setup environment is ready!`, allowed_mentions: { users: [user.id] } },
      });

      await editOriginal(token, {
        content: '',
        embeds: [{ color: COLOR.green, title: '✅ Setup Environment Provisioned', description: `Proceed in <#${setup.id}> (Self-destructs in 10 mins).\nCommand Center: <#${controllerId}>` }],
      });
    } catch (err) {
      console.error('[ERROR] Failed to execute /add-config:', err?.message || err);
      await editOriginal(token, { 
        content: '', 
        embeds: [{ color: COLOR.red, title: '⚠️ Provisioning Failed', description: `Details: \`${err?.message || 'Unknown error'}\`. Verify bot channel creation permissions.` }] 
      }).catch(() => {});
    }
    return;
  }
}