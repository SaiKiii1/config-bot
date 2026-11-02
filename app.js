// app.js
import 'dotenv/config';
import express from 'express';
import { InteractionType, InteractionResponseType, verifyKeyMiddleware } from 'discord-interactions';
import { DiscordRequest, loadStore, saveStore, slug, privateOverwrites, decryptCredential } from './utils.js';
import { startRunner } from './services/runner.js';
import { handleCommand } from './handlers/commands.js';
import { handleComponent, handleModalSubmit } from './handlers/components.js';

const app = express();
const PORT = process.env.PORT || 3000;

const store = await loadStore();
store.users ??= {};
store.drafts ??= {};
store.configs ??= {};
store.credentials ??= {};
store.access ??= {}; // NEW: Stores user clearance expirations
const save = () => saveStore(store);

const COLOR = { blurple: 0x5865f2, green: 0x57f287, red: 0xed4245, grey: 0x4f545c };
const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, custom_id, label, style, disabled });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (t) => clip(t.split('\n').map((l) => `> ${l}`).join('\n'), 1024);
const unix = (ms) => Math.floor(ms / 1000);

function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

const mineOf = (guildId, userId) =>
  Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId);

function delayModal(mode, id, current) {
  const has = current != null;
  const parts = has ? { hours: Math.floor(current / 3600), minutes: Math.floor((current % 3600) / 60), seconds: current % 60 } : {};
  const input = (custom_id, label, placeholder) => row({ type: 4, custom_id, label, style: 1, required: false, max_length: 5, placeholder, ...(has ? { value: String(parts[custom_id]) } : {}) });
  return { type: InteractionResponseType.MODAL, data: { custom_id: `modal:${mode}:${id}:delay`, title: '⏱️ Set Execution Interval', components: [input('hours', 'Hours', '0'), input('minutes', 'Minutes', '0'), input('seconds', 'Seconds', '30')] } };
}

function modal(mode, id, field, current) {
  if (field === 'delay') return delayModal(mode, id, current);
  const titles = { name: '✏️ Rename Configuration', channelId: '📍 Configure Target Channel ID', text: '💬 Define Dispatch Payload' };
  const labels = { name: 'Configuration Name', channelId: 'Destination Channel ID', text: 'Message Body' };
  return { type: InteractionResponseType.MODAL, data: { custom_id: `modal:${mode}:${id}:${field}`, title: titles[field], components: [row({ type: 4, custom_id: 'value', label: labels[field], style: field === 'text' ? 2 : 1, min_length: 1, max_length: field === 'text' ? 1000 : 50, required: true, value: current != null ? String(current) : undefined })] } };
}

function setupPanel(id, d) {
  const complete = Boolean(d.channelId && d.text && d.delay);
  const mark = (v) => (v ? '🟢' : '⚪');
  return {
    content: '',
    embeds: [{
      title: `⚙️ Configuring Pipeline: “${d.name}”`,
      color: complete ? COLOR.green : COLOR.blurple,
      fields: [
        { name: `${mark(d.channelId)} Destination Channel`, value: d.channelId ? `<#${d.channelId}>` : '*Pending...*', inline: true },
        { name: `${mark(d.delay)} Frequency Interval`, value: d.delay ? `Every ${fmtDelay(d.delay)}` : '*Pending...*', inline: true },
        { name: `${mark(d.text)} Payload Content`, value: d.text ? quote(d.text) : '*Pending...*' },
      ],
    }],
    components: [row(btn(`set:draft:${id}:channelId`, '📍 Channel ID'), btn(`set:draft:${id}:text`, '💬 Text'), btn(`set:draft:${id}:delay`, '⏱️ Delay'), btn(`confirm:${id}`, '🚀 Confirm', 3, !complete), btn(`cancel:${id}`, '❌ Abort', 4))],
  };
}

function cardPanel(id, c) {
  const status = c.running ? `🟢 **Active Pipeline**` : '🔴 **Paused**';
  return {
    content: '',
    embeds: [{
      title: `📊 Pipeline: ${c.name}`,
      description: status + (c.lastError ? `\n\n⚠️ **Alert:**\n${c.lastError}` : ''),
      color: c.lastError ? COLOR.red : c.running ? COLOR.green : COLOR.grey,
      fields: [
        { name: '📍 Target', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ Cadence', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 Dispatches', value: `\`${c.sent ?? 0}\``, inline: true },
        { name: '💬 Payload', value: quote(c.text) },
      ],
    }],
    components: [row(btn(`edit:${id}`, '✏️ Modify', 1), btn(`toggle:${id}`, c.running ? '⏹️ Terminate' : '▶️ Execute', c.running ? 4 : 3), btn(`test:${id}`, '🧪 Test'), btn(`refresh:${id}`, '🔄'), btn(`delete:${id}`, '🗑️', 4))],
  };
}

async function ensureController(guildId, user) {
  const key = `${guildId}:${user.id}`;
  const existing = store.users[key]?.controllerChannelId;
  if (existing) {
    try { await DiscordRequest(`channels/${existing}`); return existing; } catch (e) { if (e.status !== 404) throw e; }
  }
  const ch = await DiscordRequest(`guilds/${guildId}/channels`, {
    method: 'POST', body: { name: `controller-${slug(user.username)}`, type: 0, topic: '🔒 Secured Command Center', permission_overwrites: privateOverwrites(guildId, user.id) },
  });
  store.users[key] = { controllerChannelId: ch.id };
  save();
  return ch.id;
}

async function repostCards(guildId, userId, controllerId) {
  let restored = 0;
  for (const [id, c] of mineOf(guildId, userId)) {
    let ok = c.controllerChannelId === controllerId && c.cardMessageId;
    if (ok) {
      try { await DiscordRequest(`channels/${controllerId}/messages/${c.cardMessageId}`); } catch (e) { if (e.status === 404) ok = false; else throw e; }
    }
    if (!ok) {
      const msg = await DiscordRequest(`channels/${controllerId}/messages`, { method: 'POST', body: cardPanel(id, c) });
      c.controllerChannelId = controllerId;
      c.cardMessageId = msg.id;
      restored++;
    }
  }
  if (restored) save();
  return restored;
}

const refreshCard = (id) => {
  const c = store.configs[id];
  if (!c?.cardMessageId) return Promise.resolve();
  return DiscordRequest(`channels/${c.controllerChannelId}/messages/${c.cardMessageId}`, { method: 'PATCH', body: cardPanel(id, c) });
};

async function validate(field, raw, guildId, userId) {
  if (field === 'name') return raw ? { value: raw.slice(0, 50) } : { error: 'Name cannot be blank.' };
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'Invalid Snowflake ID format.' };
    try {
      const userCreds = store.credentials[userId];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;
      if (!activeToken) return { error: 'Authentication missing. Run `/add-token register`.' };
      
      const ch = await DiscordRequest(`channels/${raw}`, { token: activeToken });
      if (![0, 5].includes(ch.type)) return { error: 'Must be a text channel.' };
    } catch {
      return { error: 'Channel inaccessible or token lacks scope.' };
    }
    return { value: raw };
  }
  if (field === 'text') return raw ? { value: raw } : { error: 'Payload body cannot be empty.' };
  return { error: 'Unknown field.' };
}

function parseDelay(v) {
  const [h, m, s] = ['hours', 'minutes', 'seconds'].map((k) => Number((v[k] ?? '').trim() || 0));
  const total = h * 3600 + m * 60 + s;
  if (total < 5 || total > 86400) return { error: 'Interval out of bounds (5s to 24h).' };
  return { value: total };
}

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

app.get('/health', (req, res) => res.send('ok'));

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), (req, res) => {
  const { type } = req.body;
  if (type === InteractionType.APPLICATION_COMMAND) {
    handleCommand(req, res, store, save, mineOf, ensureController, repostCards, editOriginal, setupPanel, btn, row, refreshCard).catch(console.error);
  } else if (type === InteractionType.MESSAGE_COMPONENT) {
    handleComponent(req, res, store, save, lookup, modal, setupPanel, cardPanel, validate, parseDelay, refreshCard, editOriginal, btn, row).catch(console.error);
  } else if (type === InteractionType.MODAL_SUBMIT) {
    handleModalSubmit(req, res, store, save, lookup, validate, parseDelay, refreshCard, setupPanel).catch(console.error);
  } else {
    res.status(400).json({ error: 'unknown interaction' });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  for (const [id, c] of Object.entries(store.configs)) {
    if (c.running) startRunner(id, false, store, save, refreshCard);
  }
});