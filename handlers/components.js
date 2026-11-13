// handlers/components.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, encryptCredential, decryptCredential, redactToken, manageRole, slug, privateOverwrites } from '../utils.js';
import { startRunner, stopRunner } from '../services/runner.js';
import { getUserClient } from '../client-manager.js';

const COLOR = { blurple: 0x5865f2, green: 0x57f287, red: 0xed4245, dark: 0x2f3136, grey: 0x4f545c };

const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...data },
  });
const ephemeral = (res, content) => reply(res, { content });
const notYours = (res) => ephemeral(res, '🛡️ **Access Denied**: This configuration no longer exists or belongs to another security profile.');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (t) => clip(t.split('\n').map((l) => `> ${l}`).join('\n'), 1024);
const unix = (ms) => Math.floor(ms / 1000);

function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, custom_id, label, style, disabled });

export function cardPanel(id, c) {
  const isRunning = c.running;
  const hasError = Boolean(c.lastError);
  const statusLabel = hasError ? '⚠️ ATTENTION' : isRunning ? '🟢 RUNNING' : '🔴 PAUSED';
  const color = hasError ? COLOR.red : isRunning ? COLOR.green : COLOR.grey;

  const lineCount = c.text ? c.text.split('\n').length : 0;
  const lastRunText = c.lastSentAt ? `<t:${unix(c.lastSentAt)}:R>` : 'Never';
  const nextRunText = isRunning ? 'Scheduled' : 'Not scheduled';

  return {
    content: '',
    embeds: [{
      title: `⚡ AUTOMATEX PIPELINE CONTROL`,
      description: `**Pipeline:** \`${c.name}\`\n**Status:** ${statusLabel} managed by <@${c.userId}>\n\n**Status & Statistics**\nID \`${id.slice(0, 6)}\``,
      color: color,
      fields: [
        { name: '📍 TARGET', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ INTERVAL', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 SENT', value: `\`${c.sent ?? 0}\``, inline: true },
        { name: '🕒 LAST RUN', value: lastRunText, inline: true },
        { name: '⏳ NEXT RUN', value: nextRunText, inline: true },
        { name: '❌ FAILED', value: `\`${c.failed ?? 0}\``, inline: true },
        ...(hasError ? [{ name: '⚠️ Error Alert', value: `Last dispatch failed: ${c.lastError}` }] : []),
        { name: '💬 Current Payload', value: `${lineCount} lines · ${c.sent ?? 0} posts sent\n${quote(c.text)}` }
      ],
      footer: { text: 'Row 1 runs, pauses or tests. Row 2 edits the message, channel or interval.\nAutomateX Controller • Updated just now' },
      timestamp: new Date().toISOString()
    }],
    components: [
      row(
        btn(`toggle:${id}`, isRunning ? 'Pause' : 'Execute', isRunning ? 4 : 3),
        btn(`test:${id}`, 'Test', 2),
        btn(`refresh:${id}`, 'Refresh', 2),
        btn(`delete:${id}`, 'Delete', 4)
      ),
      row(
        btn(`edit:${id}`, 'Edit Message', 1),
        btn(`set:cfg:${id}:channelId`, 'Edit Channel', 2),
        btn(`set:cfg:${id}:delay`, 'Edit Interval', 2)
      )
    ],
  };
}

export async function handleComponent(req, res, store, saveStore, lookup, modal, setupPanel, cardPanelArg, validate, parseDelay, refreshCard, editOriginal) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;

  if (data.custom_id === 'store_free_trial') {
    store.trials ??= {};

    if (store.trials[user.id]) {
      return reply(res, { content: '⚠️ **Free Trial Already Claimed**: You have already claimed your one-time 24-hour free trial for this account.\n\nIf you would like to continue using the AutomateX auto-post service, please purchase access by opening a ticket in the support channel!' });
    }

    if (store.access[user.id]) {
      return reply(res, { content: `ℹ️ **Active Access Detected**: You already have active security clearance (\`${store.access[user.id].durationLabel}\`). You do not need a free trial right now!` });
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const expiresAt = now + DAY;

    store.trials[user.id] = { claimedAt: now };
    store.access[user.id] = { grantedAt: now, expiresAt, durationLabel: '24 Hours (Free Trial)' };
    saveStore(store);

    if (guildId) {
      await manageRole(guildId, user.id, process.env.SUBSCRIBER_ROLE_ID, 'PUT').catch(() => {});
      await manageRole(guildId, user.id, process.env.MEMBER_ROLE_ID, 'DELETE').catch(() => {});
    }

    return reply(res, {
      embeds: [{
        color: COLOR.green,
        title: '🎉 24-HOUR FREE TRIAL ACTIVATED!',
        description: `Congratulations <@${user.id}>! Your one-time 24-hour free trial has been successfully claimed.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '⏰ Access Expiration', value: `<t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>)`, inline: false },
          { name: '🚀 NEXT STEPS & SETUP GUIDE', value: '1️⃣ **Register Credential:** Run `/add-token register` to securely vault your account session token.\n2️⃣ **Provision Pipeline:** Run `/add-config name:MyFirstPost` to open your private setup workspace.\n3️⃣ **Command Center:** Control dispatches and view live metrics in your private controller channel.\n\n📌 *Need assistance? Visit <#1567854828670025748> for rules & policies or open a ticket to contact staff.*', inline: false }
        ],
        footer: { text: 'AutomateX • 1-Time Free Trial System' },
        timestamp: new Date().toISOString()
      }]
    });
  }

  if (data.custom_id === 'store_select_package') {
    if (!guildId) return ephemeral(res, '⚠️ Tickets can only be created inside the server.');

    const selected = data.values?.[0];
    const packages = {
      pkg_3d: { name: '3 Days Pass', pricePHP: '₱30', priceUSD: '~$0.55 USD', priceDLs: '10 Diamond Locks', configs: '10 Config Slots' },
      pkg_7d: { name: '7 Days Pass', pricePHP: '₱60', priceUSD: '~$1.05 USD', priceDLs: '20 Diamond Locks', configs: '25 Config Slots' },
      pkg_1m: { name: '1 Month Pass', pricePHP: '₱150', priceUSD: '~$2.60 USD', priceDLs: '50 Diamond Locks', configs: '50 Config Slots' },
      pkg_lifetime: { name: 'Lifetime Pass', pricePHP: '₱300', priceUSD: '~$5.20 USD', priceDLs: '100 Diamond Locks', configs: 'Unlimited Configs' }
    };

    const pkg = packages[selected];
    if (!pkg) return ephemeral(res, '⚠️ Invalid package selected.');

    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });

    try {
      const ticketName = `ticket-${slug(user.username)}-${selected.replace('pkg_', '')}`;
      
      const ticketChannel = await DiscordRequest(`guilds/${guildId}/channels`, {
        method: 'POST',
        body: {
          name: ticketName,
          type: 0,
          parent_id: process.env.TICKET_CATEGORY_ID,
          topic: `🎫 Order Ticket for ${user.username} | Package: ${pkg.name}`,
          permission_overwrites: privateOverwrites(guildId, user.id)
        }
      });

      const ADMIN_ID = process.env.ADMIN_ID;
      await DiscordRequest(`channels/${ticketChannel.id}/messages`, {
        method: 'POST',
        body: {
          content: `<@${user.id}> ${ADMIN_ID ? `<@${ADMIN_ID}>` : ''}`,
          embeds: [{
            color: COLOR.blurple,
            title: `🎫 ORDER TICKET — ${pkg.name.toUpperCase()}`,
            description: `Hello <@${user.id}>! Thank you for choosing AutomateX.\n\nYou have selected to purchase **${pkg.name}**.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            fields: [
              { name: '📦 Selected Package', value: `\`${pkg.name}\``, inline: true },
              { name: '⚙️ Pipeline Capacity', value: `\`${pkg.configs}\``, inline: true },
              { name: '💰 Price Options', value: `• **Local Currency:** ${pkg.pricePHP}\n• **USD International:** ${pkg.priceUSD}\n• **Growtopia:** ${pkg.priceDLs}`, inline: false },
              { name: '📜 IMPORTANT NOTICE', value: 'Before you continue purchasing, please make sure you have thoroughly read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>).', inline: false },
              { name: '💳 SELECT PAYMENT METHOD BELOW', value: 'Click a button below to view specific payment account details & instructions!', inline: false }
            ],
            footer: { text: 'AutomateX Checkout Ticket • Select payment method to proceed' },
            timestamp: new Date().toISOString()
          }],
          components: [
            row(
              btn(`pay_method:gcash:${selected}`, '🇵🇭 GCash', 3),
              btn(`pay_method:paypal:${selected}`, '🅿️ PayPal', 1),
              btn(`pay_method:wise:${selected}`, '💸 Wise', 1),
              btn(`pay_method:dls:${selected}`, '💎 Diamond Locks', 2)
            ),
            row(
              btn(`close_ticket:${ticketChannel.id}`, '🔒 Close Ticket', 4)
            )
          ]
        }
      });

      await editOriginal(token, { content: `✅ **Ticket Created!** Proceed to <#${ticketChannel.id}> to complete your order.` });
    } catch (err) {
      console.error('[ERROR] Failed to create order ticket:', err);
      await editOriginal(token, { content: `⚠️ **Ticket Creation Failed**: ${err.message}` }).catch(() => {});
    }
    return;
  }

  if (data.custom_id?.startsWith('pay_method:')) {
    const [, method] = data.custom_id.split(':');

    if (method === 'gcash') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.green,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '🇵🇭 **GCash QR Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n• **Scan the QR code below** using your GCash app to complete payment.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Please send a screenshot of the completed transaction receipt here in this channel once paid!*',
            image: { url: 'https://i.imgur.com/JHVxpgp.png' },
            footer: { text: 'AutomateX Checkout • Instant Staff Verification' }
          }]
        }
      });
    }

    if (method === 'paypal') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.green,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '🅿️ **PayPal International QR Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n• **Scan the QR code below** using your PayPal app to complete payment.\n• **Transfer Mode:** Friends & Family (F&F)\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Please send a screenshot of the payment confirmation here in this channel once sent!*',
            image: { url: 'https://i.imgur.com/XjZL7id.png' },
            footer: { text: 'AutomateX Checkout • Instant Staff Verification' }
          }]
        }
      });
    }

    if (method === 'wise') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.blurple,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '💸 **Wise International Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n• **Please wait for assistance from our admins.**\n• An administrator will respond in this ticket shortly to provide Wise payment details and assist you with your transfer.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Thank you for your patience!*',
            footer: { text: 'AutomateX Checkout • Admin Assistance Required' }
          }]
        }
      });
    }

    if (method === 'dls') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.blurple,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '💎 **Growtopia Diamond Locks (DLs) Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n• **Please wait for assistance from our admins.**\n• An administrator will join this ticket shortly to provide the World Name, trade details, or meet you in-game.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Thank you for your patience!*',
            footer: { text: 'AutomateX Checkout • Admin Assistance Required' }
          }]
        }
      });
    }
  }

  if (data.custom_id?.startsWith('close_ticket:')) {
    const channelId = data.custom_id.split(':')[1];
    res.send({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: '🔒 **Closing Ticket**: Purging channel in 5 seconds...' } });
    setTimeout(() => { DiscordRequest(`channels/${channelId}`, { method: 'DELETE' }).catch(() => {}); }, 5000);
    return;
  }

  if (data.custom_id === 'store_guide') {
    return reply(res, {
      embeds: [{
        color: COLOR.blurple,
        title: '📖 Complete Step-by-Step Guide — AutomateX',
        fields: [
          { name: '📌 STEP 1: Register Token', value: 'Run `/add-token register` in your server and input your encrypted account session token.' },
          { name: '📌 STEP 2: Provision Pipeline', value: 'Run `/add-config name:MY_PIPELINE` to generate a setup workspace.' },
          { name: '📌 STEP 3: Configure Parameters', value: 'Set destination channel ID, dispatch text message, and execution interval.' },
          { name: '📌 STEP 4: Launch Controller', value: 'Execute the pipeline from your private Command Center channel!' }
        ]
      }]
    });
  }

  if (data.custom_id === 'store_features') {
    return reply(res, {
      embeds: [{
        color: COLOR.green,
        title: '⚡ AutomateX — Core Features & Advantages',
        fields: [
          { name: '1. Serverless & Cloud Hosted 24/7', value: 'Runs on high-availability cloud infrastructure without requiring your PC to stay on.' },
          { name: '2. Hardware Encryption (AES-256-GCM)', value: 'Your Discord account tokens are encrypted at rest with isolated keys.' },
          { name: '3. Humanized Anti-Ban Telemetry', value: 'Features typing indicators, read acknowledgments, and organic jitter algorithms.' },
          { name: '4. Dedicated Sticky Residential Proxy Pools', value: 'Isolated connection tunnels per user to preserve account safety.' }
        ]
      }]
    });
  }

  const [action, ...p] = data.custom_id.split(':');

  if (action === 'confirm_delete_all') {
    await res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    const mine = Object.entries(store.configs).filter(([, c]) => c.userId === user.id && c.guildId === guildId);
    let deletedCount = 0;
    const deletePromises = [];

    for (const [cfgId, cfg] of mine) {
      if (cfg.running) stopRunner(cfgId, store);
      if (cfg.controllerChannelId && cfg.cardMessageId) {
        deletePromises.push(
          DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {})
        );
      }
      delete store.configs[cfgId];
      deletedCount++;
    }

    if (deletedCount > 0) {
      saveStore(store);
    }

    await Promise.allSettled(deletePromises);

    return DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, {
      method: 'PATCH',
      body: {
        content: `🗑️ **Workspace Cleared**: Successfully purged **${deletedCount}** configuration pipeline(s) and removed their controller cards.`,
        embeds: [],
        components: []
      }
    });
  }

  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(res, '🚫 Clearance Required: Your security clearance has expired or been revoked. You cannot interact with these controls.');
    }
  }

  if (action === 'cred' && p[0] === 'remove') {
    const label = p[1];
    if (store.credentials[user.id]?.[label]) {
      delete store.credentials[user.id][label];
      saveStore(store);
      return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: `🗑️ **Vault Updated**: Credential profile **${label}** successfully purged.`, embeds: [], components: [] } });
    }
    return ephemeral(res, '⚠️ Credential profile not found.');
  }

  if (action === 'delete_no') {
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: '✨ Action cancelled safely.', embeds: [], components: [] } });
  }

  if (action === 'set') {
    const [mode, id, field] = p;
    const target = lookup(mode, id);
    if (!target || target.userId !== user.id) return notYours(res);
    return res.send(modal(mode, id, field, target[field]));
  }

  if (action === 'cancel') {
    const [id] = p;
    const d = store.drafts[id];
    if (!d || d.userId !== user.id) return notYours(res);
    delete store.drafts[id];
    saveStore(store);
    res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: '', embeds: [{ color: COLOR.dark, title: '❌ Pipeline Aborted', description: 'Destroying setup channel in 5 seconds…' }], components: [] } });
    setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(() => {}), 5000);
    return;
  }

  if (action === 'confirm') {
    const [id] = p;
    const d = store.drafts[id];
    if (!d || d.userId !== user.id) return notYours(res);
    if (!(d.channelId && d.text && d.delay)) return ephemeral(res, '⚠️ Incomplete telemetry: Fill all required parameters.');

    res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    try {
      const controllerId = store.users[`${d.guildId}:${d.userId}`]?.controllerChannelId;
      const cfg = {
        userId: d.userId, guildId: d.guildId, name: d.name,
        channelId: d.channelId, text: d.text, delay: d.delay,
        running: false, lastError: null, sent: 0, lastSentAt: null, startedAt: null,
        controllerChannelId: controllerId, cardMessageId: null,
      };
      store.configs[id] = cfg;
      const msg = await DiscordRequest(`channels/${controllerId}/messages`, { method: 'POST', body: cardPanel(id, cfg) });
      cfg.cardMessageId = msg.id;
      delete store.drafts[id];
      saveStore(store);

      await editOriginal(token, {
        content: '',
        embeds: [{ color: COLOR.green, title: `🚀 Task “${d.name}” Initialized!`, description: `Card registered in <#${controllerId}>.` }],
        components: [],
      });
      setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(() => {}), 5000);
    } catch (err) {
      delete store.configs[id];
      await editOriginal(token, { ...setupPanel(id, d), content: '⚠️ Initialization fault encountered.' }).catch(() => {});
    }
    return;
  }

  if (action === 'edit') {
    const cfgId = p[0];
    const cfg = store.configs[cfgId];
    if (!cfg || cfg.userId !== user.id) return notYours(res);
    
    const panel = cardPanel(cfgId, cfg);
    panel.components = [
      row(
        btn(`set:cfg:${cfgId}:name`, 'Rename', 2),
        btn(`set:cfg:${cfgId}:channelId`, 'Target ID', 2),
        btn(`set:cfg:${cfgId}:text`, 'Message Text', 2),
        btn(`set:cfg:${cfgId}:delay`, 'Timer', 2),
        btn(`refresh:${cfgId}`, '🔙 Cancel', 4)
      )
    ];
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: panel });
  }

  const cfgId = p[0];
  const cfg = store.configs[cfgId];
  if (!cfg || cfg.userId !== user.id) return notYours(res);

  if (action === 'toggle') {
    cfg.running = !cfg.running;
    cfg.lastError = null;
    cfg.startedAt = cfg.running ? Date.now() : null;
    saveStore(store);
    res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
    if (cfg.running) startRunner(cfgId, true, store, saveStore, refreshCard);
    else stopRunner(cfgId, store);
    return;
  }

  if (action === 'refresh') {
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
  }

  if (action === 'test') {
    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
    try {
      const userCreds = store.credentials[user.id];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;
      if (!activeToken) {
        await editOriginal(token, { content: '⚠️ Authentication missing. Register a token via `/add-token register`.' });
        return;
      }
      
      const client = await getUserClient(user.id, activeToken);
      const channel = await client.channels.fetch(cfg.channelId);
      await channel.send({ content: cfg.text, allowed_mentions: { parse: [] } });
      
      await editOriginal(token, { content: `🧪 **Test Dispatch Successful**: Message transmitted to <#${cfg.channelId}>.` });
    } catch (err) {
      console.error('TEST ERROR:', err);
      await editOriginal(token, { content: `⚠️ **Dispatch Rejected**: ${err.message}` }).catch(() => {});
    }
    return;
  }

  if (action === 'delete') {
    return reply(res, {
      content: `🗑️ **Confirm Deletion**: Permanently delete **${cfg.name}**?`,
      components: [row(btn(`delete_yes:${cfgId}`, 'Confirm Deletion', 4), btn('delete_no', 'Abort'))],
    });
  }

  if (action === 'delete_yes') {
    stopRunner(cfgId, store);
    delete store.configs[cfgId];
    saveStore(store);
    res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: `🗑️ Task **${cfg.name}** permanently purged.`, embeds: [], components: [] } });
    DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
  }
}

export async function handleModalSubmit(req, res, store, saveStore, lookup, validate, parseDelay, refreshCard, setupPanel) {
  const { data } = req.body;
  const user = req.body.member?.user ?? req.body.user;

  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(res, '🚫 Clearance Required: Your security clearance has expired or been revoked.');
    }
  }

  if (data.custom_id === 'modal:add-token:save') {
    if (Object.keys(store.credentials[user.id] || {}).length >= 1) {
      return ephemeral(res, '⚠️ Limit exceeded: You can only register 1 token profile at a time.');
    }
    const values = Object.fromEntries(data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']));
    const label = (values.label_name || 'default').trim();
    const rawToken = (values.token_value || '').trim();
    if (!rawToken) return ephemeral(res, '⚠️ Credential payload cannot be blank.');

    store.credentials[user.id] = {
      [label]: { encrypted: encryptCredential(rawToken), redacted: redactToken(rawToken), createdAt: Date.now() },
    };
    saveStore(store);
    return ephemeral(res, `✅ **Credential Secured (1/1 Limit Reached)**: Profile **${label}** encrypted at rest.`);
  }

  const [, mode, id, field] = data.custom_id.split(':');
  const target = lookup(mode, id);
  if (!target || target.userId !== user.id) return notYours(res);

  const values = Object.fromEntries(data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']));
  const result = field === 'delay' ? parseDelay(values) : await validate(field, (values.value ?? '').trim(), target.guildId, user.id, store);
  if (result.error) return ephemeral(res, `⚠️ ${result.error}`);

  target[field] = result.value;
  saveStore(store);

  if (mode === 'draft') {
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: setupPanel(id, target) });
  }
  if (field === 'delay' && target.running) startRunner(id, false, store, saveStore, refreshCard);
  if (field === 'channelId') target.lastError = null;
  refreshCard(id).catch(() => {});
  return ephemeral(res, '✅ **Telemetry Updated**: Controller card synchronized.');
}