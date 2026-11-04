// handlers/commands.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, slug, privateOverwrites, redactToken, sendDM, manageRole } from '../utils.js';
import { stopAllRunnersForUser, stopRunner } from '../services/runner.js';

const COLOR = { blurple: 0x5865f2, green: 0x57f287, amber: 0xfee75c, red: 0xed4245 };
const MAX_CONFIGS = 10;
const MAX_OPEN_SETUPS = 3;

const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...data },
  });
const ephemeral = (res, content) => reply(res, { content });
const notice = (res, color, title, description) => reply(res, { embeds: [{ color, title, description }] });

const helpEmbed = () => ({
  color: COLOR.blurple,
  title: '🛡️ AutomateX — Command Center',
  description: 'Enterprise-grade Discord automation framework featuring officially supported bot dispatch and secure credential vaulting.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your bot automation credential.\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and manage active dispatches.',
    },
  ],
  footer: { text: 'AutomateX • Secure. Automated. Reliable.' },
});

export function credentialInputModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'modal:add-token:save',
      title: '🔐 Secure Bot Credential Registration (Limit: 1)',
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'label_name', label: 'Bot Profile Label', style: 1, required: true, max_length: 50, placeholder: 'e.g., Primary-Bot-Instance' }] },
        { type: 1, components: [{ type: 4, custom_id: 'token_value', label: 'Discord Bot Token', style: 1, required: true, min_length: 50, max_length: 200, placeholder: 'Paste bot token (encrypted at rest)' }] }
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
  if (name !== 'grant-access' && name !== 'revoke-access' && name !== 'promotion') {
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
      footer: { text: 'AutomateX Security & Access Management' }
    };

    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [embed], flags: 64 }
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
          description: 'Welcome to **AutomateX**!\n\nThe ultimate enterprise-grade Discord automation framework. We provide intelligent, supported bot dispatch systems to keep your workflows efficient.',
          fields: [
            { name: '🛡️ SUPPORTED API', value: 'Official bot integration compliant with Discord standards.', inline: true },
            { name: '⚡ SMART PRE-FLIGHT', value: 'Prevents duplicate message spam to protect channel integrity.', inline: true },
            { name: '🔐 SECURE VAULT', value: 'AES-256-GCM encrypted token storage for maximum safety.', inline: true },
            { name: '⏱️ DYNAMIC CADENCE', value: 'Fully customizable delays, controller panels, and deployment pipelines.', inline: true },
            { name: '📌 HOW TO GET STARTED', value: '1. Head over to support and open a ticket.\n2. Once verified, your access will be granted.\n3. Run `/add-token register` to securely vault your bot.\n4. Provision your pipeline using `/add-config`.\n5. Manage your active posts in your private Command Center.', inline: false }
          ],
          footer: { text: '🔒 AutomateX • Secure. Automated. Reliable.' }
        }]
      }
    });
  }

  // --- SERVER RULES EMBED (ADMIN ONLY) ---
  if (name === 'rules') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [{
          color: 0x5865f2,
          title: '🛡️ AUTOMATEX — SERVER RULES',
          description: 
            '**WELCOME TO AUTOMATEX!**\n' +
            'Please read and follow the rules below to keep the server comfortable, safe, and orderly for everyone.\n\n' +
            '**1. Respect Everyone** — Respect members and staff.\n' +
            '**2. No Sensitive Topics** — Keep discussions appropriate.\n' +
            '**3. No Spam / Promotion** — Unauthorized advertising is prohibited.\n' +
            '**4. Use Official Tickets** — Support inquiries must be made through tickets.\n' +
            '**5. Transactions & Buyer Responsibility** — Check details before paying.\n' +
            '**6. Staff Decisions** — Staff decisions are final.',
          footer: { text: '🔒 AutomateX • Secure. Automated. Reliable.' }
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
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been activated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Duration:** ${label}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*AutomateX Admin Action*`
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
        description: `Hello <@${targetUser}>! Your AutomateX subscription access has been deactivated.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Reason:** ${reason}\n**Security Action:** All your bot credentials, posting configurations, and controller channels have been cleared.`
      }]
    });

    return notice(res, COLOR.green, '🗑️ Operator Purged', `Operator <@${targetUser}> authorization terminated.\n🛑 **${terminated} pipeline(s) destroyed and credential vault wiped.**`);
  }

  // --- STANDARD COMMANDS ---
  if (name === 'add-token') {
    const actionOption = data.options?.[0]?.name;

    if (!actionOption) {
      return ephemeral(res, '⚠️ **Usage Error**: Please specify a subcommand (e.g., `/add-token register`, `/add-token list`, or `/add-token remove`).');
    }

    if (actionOption === 'register') {
      const existingTokens = Object.keys(store.credentials[user.id] || {});
      if (existingTokens.length >= 1) {
        return notice(
          res, COLOR.amber, '⚠️ Token Limit Reached',
          `Your account is restricted to a maximum of **1** registered bot credential.\n\nCurrently registered profile: \`${existingTokens[0]}\`\n\nUse \`/add-token remove\` if you wish to purge and replace it.`
        );
      }
      return res.send(credentialInputModal());
    }

    if (actionOption === 'list') {
      const userCreds = Object.entries(store.credentials[user.id] || {});
      if (!userCreds.length) {
        return notice(res, COLOR.amber, '⚠️ No Credentials Found', 'Your security profile has no registered bot tokens.\n\nExecute `/add-token register` to begin.');
      }
      const fields = userCreds.map(([label, cred]) => ({
        name: `🏷️ Profile: ${label}`,
        value: `Registered: <t:${Math.floor(cred.createdAt / 1000)}:R>\nFingerprint: \`${cred.redacted}\``,
      }));
      return reply(res, { embeds: [{ color: COLOR.blurple, title: '🔐 Vault: Registered Bot Credentials (Limit 1/1)', fields }] });
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
    return reply(res, {
      embeds: [{
        color: COLOR.blurple,
        title: `📋 Configuration Registry (${mine.length}/${MAX_CONFIGS})`,
        description: ctrl ? `Manage active pipelines in <#${ctrl}>.` : undefined,
        fields: mine.map(([, c]) => ({
          name: `${c.running ? '🟢' : '🔴'} ${c.name.slice(0, 200)}`,
          value: `Dest: <#${c.channelId}> · Dispatches: \`${c.sent ?? 0}\``,
        })),
      }],
    });
  }

  if (name === 'controller') {
    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
    try {
      const controllerId = await ensureController(guildId, user);
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
      return notice(res, COLOR.red, '🚫 Authorization Blocked', 'Security policy requires a registered bot credential before provisioning pipelines.\n\n👉 Run `/add-token register` first.');
    }

    const cfgName = data.options[0].value.trim().slice(0, 50);
    if (!cfgName) return ephemeral(res, '⚠️ Configuration name cannot be empty.');

    const saved = mineOf(guildId, user.id).length;
    const open = Object.values(store.drafts).filter((d) => d.userId === user.id && d.guildId === guildId).length;
    if (saved + open >= MAX_CONFIGS) return notice(res, COLOR.red, '⚠️ Quota Exceeded', `Maximum limit of **${MAX_CONFIGS}** configurations reached.`);
    if (open >= MAX_OPEN_SETUPS) return notice(res, COLOR.red, '⚠️ Unfinished Setups', `Please complete or cancel your ${open} pending setup channels first.`);

    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
    try {
      const controllerId = await ensureController(guildId, user);
      await repostCards(guildId, user.id, controllerId);
      const setup = await DiscordRequest(`guilds/${guildId}/channels`, {
        method: 'POST',
        body: {
          name: `setup-${slug(cfgName)}`,
          type: 0,
          topic: '🔒 Secured setup channel. Automatically purges upon initialization.',
          permission_overwrites: privateOverwrites(guildId, user.id),
        },
      });
      const draft = { userId: user.id, username: user.username, guildId, name: cfgName, channelId: null, text: null, delay: null, createdAt: Date.now() };
      store.drafts[setup.id] = draft;
      saveStore(store);
      await DiscordRequest(`channels/${setup.id}/messages`, {
        method: 'POST',
        body: { ...setupPanel(setup.id, draft), content: `<@${user.id}> Your pipeline setup environment is ready!`, allowed_mentions: { users: [user.id] } },
      });
      await editOriginal(token, {
        content: '',
        embeds: [{ color: COLOR.green, title: '✅ Setup Environment Provisioned', description: `Proceed in <#${setup.id}>.\nCommand Center: <#${controllerId}>` }],
      });
    } catch (err) {
      await editOriginal(token, { content: '', embeds: [{ color: COLOR.red, title: '⚠️ Provisioning Failed', description: 'Verify bot channel creation permissions.' }] }).catch(() => {});
    }
  }
}