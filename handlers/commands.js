// handlers/commands.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, slug, privateOverwrites, redactToken } from '../utils.js';
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
  title: '🛡️ Research Security Framework — Command Center',
  description: 'Enterprise-grade automated telemetry dispatcher utilizing user-session credential simulations.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your single account token.\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and audit payloads.',
    },
  ],
  footer: { text: 'Academic Cybersecurity Case Study Framework v2.6' },
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

export async function handleCommand(req, res, store, saveStore, mineOf, ensureController, repostCards, editOriginal, setupPanel, btn, row) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;
  const { name } = data;
  
  const ADMIN_ID = process.env.ADMIN_ID;

  if (name === 'help') return reply(res, { embeds: [helpEmbed()] });
  if (!guildId) return ephemeral(res, '⚠️ **Context Error**: Command execution restricted to guild servers.');

  // --- AUTHORIZATION GATE ---
  if (name !== 'grant-access' && name !== 'revoke-access') {
    const access = store.access[user.id];
    const now = Date.now();
    
    // Admins bypass the gate automatically
    if (user.id !== ADMIN_ID) {
      if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
        if (access) {
          delete store.access[user.id]; // Purge expired clearance immediately
          saveStore(store);
        }
        return notice(res, COLOR.red, '🚫 Clearance Required', 'You do not have active security clearance to operate this framework. Please contact the administrator.');
      }
    }
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
    return notice(res, COLOR.green, '✅ Clearance Granted', `Operator <@${targetUser}> has been authorized.\n**Duration:** ${label}`);
  }

  if (name === 'revoke-access') {
    if (user.id !== ADMIN_ID) return ephemeral(res, '🚫 Access Denied: Administrator privileges required.');
    const targetUser = data.options.find(o => o.name === 'user').value;
    delete store.access[targetUser];

    // SYSTEM-WIDE KILL SWITCH: Halt all running pipelines for the revoked user
    let terminated = 0;
    for (const [id, c] of Object.entries(store.configs)) {
      if (c.userId === targetUser && c.running) {
        stopRunner(id, store);
        c.running = false;
        c.startedAt = null;
        c.lastError = '⚠️ Access Revoked: Security clearance terminated by administrator.';
        terminated++;
      }
    }

    saveStore(store);
    return notice(res, COLOR.green, '🗑️ Clearance Revoked', `Operator <@${targetUser}> authorization terminated.\n🛑 **${terminated} active pipeline(s) halted.**`);
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