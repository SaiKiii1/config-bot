// handlers/commands.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, slug, privateOverwrites, redactToken, sendDM, manageRole } from '../utils.js';
import { stopAllRunnersForUser, stopRunner } from '../services/runner.js';

const COLOR = { blurple: 0x5865f2, green: 0x57f287, amber: 0xfee75c, red: 0xed4245 };
const MAX_OPEN_SETUPS = 3;

const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...data },
  });
const ephemeral = (res, content) => reply(res, { content });
const notice = (res, color, title, description) => reply(res, { embeds: [{ color, title, description }] });

// Helper to resolve dynamic quota limits based on clearance tier
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
  if (label.includes('Free Trial') || label.includes('24 Hours')) return 5;

  return 5;
}

const helpEmbed = () => ({
  color: COLOR.blurple,
  title: '🛡️ AutomateX — Command Center & Guide',
  description: 'Enterprise-grade Discord automation framework featuring humanized dispatch and secure credential vaulting.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your single account token.\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and manage active dispatches.',
    },
    {
      name: '🧭 Server Guide & Channels',
      value:
        '• <#1567854828670025748> — Review our legal policies, safety heuristics, and terms of service.\n' +
        '• <#1567187360733601833> — Read community guidelines and core server rules.\n' +
        '• <#1567211746953797743> — Stay updated with official system updates and announcements.\n' +
        '• <#1567212596061540552> — A dedicated space to chat, converse, and hang out with other members.\n' +
        '• <#1567212628386783242> — The recommended channel for executing bot and slash commands to keep things clean and organized.',
    },
  ],
  footer: { text: 'AutomateX • Secure. Automated. Reliable.' },
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
  
  const ADMIN_ID = process.env.ADMIN_ID;

  if (name === 'help') return reply(res, { embeds: [helpEmbed()] });
  if (!guildId) return ephemeral(res, '⚠️ **Context Error**: Command execution restricted to guild servers.');

  // --- AUTHORIZATION GATE ---
  if (name !== 'grant-access' && name !== 'revoke-access' && name !== 'promotion' && name !== 'store') {
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
                'Package     Price (PHP/USD)   Diamond Locks   Configs\n' +
                '───────────────────────────────────────────────────────\n' +
                '🎁 Free     FREE ($0.00)      0 DLs (24h)     5 Slots\n' +
                '🥉 3 Days   ₱30 (~$0.55)      10 DLs          10 Slots\n' +
                '🥈 7 Days   ₱60 (~$1.05)      20 DLs          25 Slots\n' +
                '🥇 1 Month  ₱150 (~$2.60)     50 DLs          50 Slots\n' +
                '👑 Lifetime ₱300 (~$5.20)     100 DLs         Unlimited\n' +
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
                  { label: '3 Days Pass', value: 'pkg_3d', description: '₱30 (~$0.55 USD) / 10 DLs • 10 Config Slots', emoji: { name: '🥉' } },
                  { label: '7 Days Pass', value: 'pkg_7d', description: '₱60 (~$1.05 USD) / 20 DLs • 25 Config Slots', emoji: { name: '🥈' } },
                  { label: '1 Month Pass', value: 'pkg_1m', description: '₱150 (~$2.60 USD) / 50 DLs • 50 Config Slots', emoji: { name: '🥇' } },
                  { label: 'Lifetime Pass', value: 'pkg_lifetime', description: '₱300 (~$5.20 USD) / 100 DLs • Unlimited Configs', emoji: { name: '👑' } }
                ]
              }
            ]
          },
          {
            type: 1,
            components: [
              { type: 2, custom_id: 'store_free_trial', label: '🎁 Free Trial (24h)', style: 3 },
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
    const targetUser = data.options?.find(o => o.name === 'target')?.value;
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
              value: '1. Head over to <#1567206278579621888> and click **Create ticket** to purchase access.\n2. Once your subscription is verified by our staff, your access will be granted.\n3. Run `/add-token register` to securely vault your account.\n4. Provision your pipeline using `/add-config`.\n5. Manage your active posts in your private Command Center.',
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
    const targetUser = data.options.find(o => o.name === 'user').value;
    const duration = data.options.find(o => o.name === 'duration').value;
    
    let expiresAt;
    let label;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    
    switch(duration) {
      case '24h': expiresAt = now + DAY; label = '24 Hours'; break;
      case '3d': expiresAt = now + (3 * DAY); label = '3 Days'; break;
      case '1w': expiresAt = now + (7 * DAY); label = '1 Week'; break;
      case '1m': expiresAt = now + (30 * DAY); label = '1 Month'; break;
      case 'perm': expiresAt = 'permanent'; label = 'Permanent'; break;
    }

    store.access[targetUser] = { grantedAt: now, expiresAt, durationLabel: label };
    saveStore(store);

    await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'PUT');
    await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'DELETE');

    sendDM(targetUser, {
      embeds: [{
        color: COLOR.green,
        title: '🟢 SUBSCRIPTION ACCESS GRANTED',
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been activated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Duration:** ${label}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    });

    return notice(res, COLOR.green, '✅ Clearance Granted', `Operator <@${targetUser}> has been authorized.\n**Duration:** ${label}`);
  }

  if (name === 'revoke-access') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    const targetUser = data.options.find(o => o.name === 'user').value;
    const reasonOpt = data.options.find(o => o.name === 'reason');
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

    await manageRole(guildId, targetUser, process.env.SUBSCRIBER_ROLE_ID, 'DELETE');
    await manageRole(guildId, targetUser, process.env.MEMBER_ROLE_ID, 'PUT');

    sendDM(targetUser, {
      embeds: [{
        color: COLOR.red,
        title: '🔴 SUBSCRIPTION ACCESS REVOKED',
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been deactivated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Reason:** ${reason}\n**Security Action:** All your account token data, posting configurations, and controller channels have been cleared from the database.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Security Action*\n<t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    });

    return notice(res, COLOR.green, '🗑️ Operator Purged', `Operator <@${targetUser}> authorization terminated.\n🛑 **${terminated} pipeline(s) destroyed and credential vault wiped.**`);
  }

  // --- STANDARD COMMANDS ---
  if (name === 'add-token') {
    const actionOption = data.options?.find((o) => o.name === 'action')?.value;

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

    // Respond immediately using standard source message response to prevent timeouts
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
    const stopped = stopAllRunnersForUser(guildId, user.id, store, saveStore);
    
    for (const [id] of stopped) {
      refreshCard(id).catch(() => {});
    }

    await editOriginal(token, {
      content: stopped.length ? `⏹️ **Emergency Halt**: Successfully terminated ${stopped.length} active pipeline(s).` : 'ℹ️ No active pipelines were running.',
    }).catch(() => {});
    return;
  }

  if (name === 'add-config') {
    const userTokens = Object.keys(store.credentials[user.id] || {});
    if (!userTokens.length) {
      return notice(res, COLOR.red, '🚫 Authorization Blocked', 'Security policy requires a registered user credential before provisioning pipelines.\n\n👉 Run `/add-token register` first.');
    }

    const cfgName = data.options?.[0]?.value?.trim()?.slice(0, 50);
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

      const controllerId = await ensureController(guildId, user, store, saveStore);
      await repostCards(guildId, user.id, controllerId);
      
      const randSuffix = Math.random().toString(36).substring(2, 6);
      const setupChannelName = `setup-${slug(cfgName)}-${randSuffix}`;

      // Provision setup workspace channel inside USER_SETUP_ID category
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

      // --- 10-MINUTE AUTOMATIC EXPIRATION TIMER ---
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