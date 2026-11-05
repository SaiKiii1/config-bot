// handlers/components.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { DiscordRequest, encryptCredential, decryptCredential, redactToken } from '../utils.js';
import { startRunner, stopRunner } from '../services/runner.js';

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

function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, custom_id, label, style, disabled });

// --- REDESIGNED SPACIOUS CARD PANEL UI ---
function cardPanel(id, c) {
  const status = c.running ? `🟢 **Running**` : '🔴 **Paused**';
  return {
    content: '',
    embeds: [{
      title: `📊 Task: ${c.name}`,
      description: status + (c.lastError ? `\n\n⚠️ **Error Alert:**\n${c.lastError}` : ''),
      color: c.lastError ? COLOR.red : c.running ? COLOR.green : COLOR.grey,
      fields: [
        { name: '📍 Target Channel', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ Interval Timer', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 Total Sent', value: `\`${c.sent ?? 0}\``, inline: true },
        { name: '💬 Message Text', value: quote(c.text) },
      ],
      footer: { text: 'AutomateX Control Panel • Simple & Secure' },
      timestamp: new Date().toISOString()
    }],
    components: [
      // Row 1: Start/Stop & Quick Actions (Spacious & Clean)
      row(
        btn(`toggle:${id}`, c.running ? '⏹️ Stop' : '▶️ Start', c.running ? 4 : 3),
        btn(`test:${id}`, '🧪 Test Message', 2),
        btn(`refresh:${id}`, '🔄 Refresh', 2)
      ),
      // Row 2: Editing & Deleting
      row(
        btn(`edit:${id}`, '✏️ Edit Text', 1),
        btn(`set:cfg:${id}:channelId`, '📍 Channel', 2),
        btn(`set:cfg:${id}:delay`, '⏱️ Change Timer', 2),
        btn(`delete:${id}`, '🗑️ Delete', 4)
      )
    ],
  };
}

export async function handleComponent(req, res, store, saveStore, lookup, modal, setupPanel, cardPanelArg, validate, parseDelay, refreshCard, editOriginal) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const [action, ...p] = data.custom_id.split(':');

  // --- COMPONENT AUTHORIZATION GATE ---
  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(res, '🚫 Clearance Required: Your security clearance has expired or been revoked. You cannot interact with these controls.');
    }
  }
  // ------------------------------------

  if (action === 'cred' && p[0] === 'remove') {
    const label = p[1];
    if (store.credentials[user.id]?.[label]) {
      delete store.credentials[user.id][label];
      saveStore(store);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: `🗑️ **Vault Updated**: Credential profile **${label}** successfully purged.`, embeds: [], components: [] },
      });
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
    res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: '', embeds: [{ color: COLOR.dark, title: '❌ Pipeline Aborted', description: 'Destroying setup channel in 5 seconds…' }], components: [] },
    });
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
      await DiscordRequest(`channels/${cfg.channelId}/messages`, {
        method: 'POST', token: activeToken, body: { content: cfg.text, allowed_mentions: { parse: [] } },
      });
      await editOriginal(token, { content: `🧪 **Test Dispatch Successful**: Message transmitted to <#${cfg.channelId}>.` });
    } catch (err) {
      await editOriginal(token, { content: `⚠️ **Dispatch Rejected**: Target channel lacks permissions or token session expired.` }).catch(() => {});
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

  // --- MODAL AUTHORIZATION GATE ---
  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(res, '🚫 Clearance Required: Your security clearance has expired or been revoked.');
    }
  }
  // --------------------------------

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