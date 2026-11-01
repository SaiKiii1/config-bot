import 'dotenv/config';
import express from 'express';
import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { DiscordRequest, loadStore, saveStore, slug, privateOverwrites, encryptCredential, decryptCredential, redactToken } from './utils.js';

const app = express();
const PORT = process.env.PORT || 3000;

const store = await loadStore();
store.users ??= {};
store.drafts ??= {};
store.configs ??= {};
store.botIntegrations ??= {};
store.credentials ??= {};
const save = () => saveStore(store);
const timers = new Map();

const MIN_DELAY = 5;
const MAX_DELAY = 86400;
const MAX_CONFIGS = 10;
const MAX_OPEN_SETUPS = 3;
const DRAFT_TTL = 24 * 60 * 60 * 1000;

const COLOR = { blurple: 0x5865f2, green: 0x57f287, red: 0xed4245, grey: 0x4f545c };
const PRIMARY = 1, SECONDARY = 2, SUCCESS = 3, DANGER = 4;
const NO_PINGS = { parse: [] };

const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = SECONDARY, disabled = false) => ({
  type: 2, custom_id, label, style, disabled,
});
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (t) => clip(t.split('\n').map((l) => `> ${l}`).join('\n'), 1024);
const unix = (ms) => Math.floor(ms / 1000);

function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: NO_PINGS, ...data },
  });
const ephemeral = (res, content, components) => reply(res, { content, components });
const notice = (res, color, title, description) => reply(res, { embeds: [{ color, title, description }] });
const notYours = (res) => ephemeral(res, '⚠️ That config doesn\'t exist anymore, or it isn\'t yours.');

const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

const mineOf = (guildId, userId) =>
  Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId);

const FIELDS = {
  name: { title: 'Rename config', label: 'Config name', style: 1, max: 50, placeholder: 'e.g. Daily reminder' },
  channelId: { title: 'Set channel ID', label: 'Channel ID', style: 1, max: 20, placeholder: 'e.g. 123456789012345678' },
  text: { title: 'Set text', label: 'Message text', style: 2, max: 1000, placeholder: 'What should I post?' },
  delay: { title: 'Set delay timer' },
};

function delayModal(mode, id, current) {
  const has = current != null;
  const parts = has
    ? { hours: Math.floor(current / 3600), minutes: Math.floor((current % 3600) / 60), seconds: current % 60 }
    : {};
  const input = (custom_id, label, placeholder) =>
    row({
      type: 4, custom_id, label, style: 1, required: false, max_length: 5, placeholder,
      ...(has ? { value: String(parts[custom_id]) } : {}),
    });
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:delay`,
      title: FIELDS.delay.title,
      components: [input('hours', 'Hours', '0'), input('minutes', 'Minutes', '0'), input('seconds', 'Seconds', '30')],
    },
  };
}

function credentialInputModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'modal:add-token:save',
      title: 'Register Account User Token',
      components: [
        row({
          type: 4,
          custom_id: 'label_name',
          label: 'Token Label / Identifier',
          style: 1,
          required: true,
          max_length: 50,
          placeholder: 'e.g. My-Primary-Account',
        }),
        row({
          type: 4,
          custom_id: 'token_value',
          label: 'Discord User Token',
          style: 1,
          required: true,
          min_length: 50,
          max_length: 200,
          placeholder: 'Paste your account token here (encrypted securely)',
        }),
      ],
    },
  };
}

function modal(mode, id, field, current) {
  if (field === 'delay') return delayModal(mode, id, current);
  const f = FIELDS[field];
  const value = current == null ? undefined : String(current);
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:${field}`,
      title: f.title,
      components: [
        row({
          type: 4, custom_id: 'value', label: f.label, style: f.style,
          min_length: 1, max_length: f.max, required: true, placeholder: f.placeholder, value,
        }),
      ],
    },
  };
}

function setupPanel(id, d) {
  const complete = Boolean(d.channelId && d.text && d.delay);
  const mark = (v) => (v ? '✅' : '⬜');
  return {
    content: '',
    embeds: [{
      title: `⚙️ Setting up “${d.name}”`,
      description:
        'Fill in each setting with the buttons below. When all three are ✅, press **Confirm**.\n' +
        '-# Need a channel ID? Turn on Developer Mode in Discord settings, then right-click a channel → Copy Channel ID.',
      color: complete ? COLOR.green : COLOR.blurple,
      fields: [
        { name: `${mark(d.channelId)} Target channel`, value: d.channelId ? `<#${d.channelId}>` : '*Not set yet*', inline: true },
        { name: `${mark(d.delay)} Delay`, value: d.delay ? `Every ${fmtDelay(d.delay)}` : '*Not set yet*', inline: true },
        { name: `${mark(d.text)} Message text`, value: d.text ? quote(d.text) : '*Not set yet*' },
      ],
      footer: { text: '🔒 Private channel — authenticated via user token simulation.' },
    }],
    components: [
      row(
        btn(`set:draft:${id}:channelId`, 'Set channel ID'),
        btn(`set:draft:${id}:text`, 'Set text'),
        btn(`set:draft:${id}:delay`, 'Set delay timer'),
        btn(`confirm:${id}`, '✔ Confirm', SUCCESS, !complete),
        btn(`cancel:${id}`, 'Cancel', DANGER),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

function cardPanel(id, c) {
  const status = c.running
    ? `🟢 **Running (User Token Auth)**${c.startedAt ? ` · started <t:${unix(c.startedAt)}:R>` : ''}`
    : '🔴 **Stopped**';
  return {
    content: '',
    embeds: [{
      title: `📌 ${c.name}`,
      description: status + (c.lastError ? `\n⚠️ ${c.lastError}` : ''),
      color: c.lastError ? COLOR.red : c.running ? COLOR.green : COLOR.grey,
      fields: [
        { name: '📍 Channel ID', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ Delay', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 Posts sent', value: String(c.sent ?? 0), inline: true },
        { name: '🕒 Last post', value: c.lastSentAt ? `<t:${unix(c.lastSentAt)}:R>` : '—', inline: true },
        { name: '💬 Text', value: quote(c.text) },
      ],
      footer: { text: 'Dispatched via registered user account token.' },
    }],
    components: [
      row(
        btn(`edit:${id}`, '✏️ Edit', PRIMARY),
        btn(`toggle:${id}`, c.running ? '⏹️ Stop' : '▶️ Start', c.running ? DANGER : SUCCESS),
        btn(`test:${id}`, '🧪 Test'),
        btn(`refresh:${id}`, '🔄'),
        btn(`delete:${id}`, '🗑️', DANGER),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

const helpEmbed = () => ({
  color: COLOR.blurple,
  title: '🤖 Config Bot — Research Case Study',
  description: 'Automated messaging system driven by user account token authentication.',
  fields: [
    {
      name: 'Required Workflow',
      value:
        '1️⃣ Run `/add-token register` to store your user account token securely.\n' +
        '2️⃣ Run `/add-config name` to create an automation configuration.\n' +
        '3️⃣ Complete setup and press **Start** to post messages using your user token.',
    },
  ],
});

async function ensureController(guildId, user) {
  const key = `${guildId}:${user.id}`;
  const existing = store.users[key]?.controllerChannelId;
  if (existing) {
    try {
      await DiscordRequest(`channels/${existing}`);
      return existing;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const ch = await DiscordRequest(`guilds/${guildId}/channels`, {
    method: 'POST',
    body: {
      name: `controller-${slug(user.username)}`,
      type: 0,
      topic: 'Your control panel: edit, start, stop, test and delete your configs.',
      permission_overwrites: privateOverwrites(guildId, user.id),
    },
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
      try {
        await DiscordRequest(`channels/${controllerId}/messages/${c.cardMessageId}`);
      } catch (e) {
        if (e.status === 404) ok = false;
        else throw e;
      }
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
  return DiscordRequest(`channels/${c.controllerChannelId}/messages/${c.cardMessageId}`, {
    method: 'PATCH',
    body: cardPanel(id, c),
  });
};

/* ------------------------------------------------------------------ */
/* Runner: dispatches messages using the user's decrypted account token */
/* ------------------------------------------------------------------ */
function stopRunner(id) {
  clearInterval(timers.get(id));
  timers.delete(id);
}

function startRunner(id, immediate = true) {
  stopRunner(id);
  const c = store.configs[id];
  if (!c) return;

  const userCreds = store.credentials[c.userId];
  const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
  const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

  const tick = async () => {
    const currentConfig = store.configs[id];
    if (!currentConfig) return stopRunner(id);

    if (!activeToken) {
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = 'Stopped: No registered user token found. Use /add-token first.';
      save();
      refreshCard(id).catch(() => {});
      return stopRunner(id);
    }

    try {
      await DiscordRequest(`channels/${currentConfig.channelId}/messages`, {
        method: 'POST',
        token: activeToken,
        body: { content: currentConfig.text, allowed_mentions: NO_PINGS },
      });
      currentConfig.sent = (currentConfig.sent ?? 0) + 1;
      currentConfig.lastSentAt = Date.now();
      if (currentConfig.sent % 10 === 0) save();
    } catch (err) {
      if (!err.status || err.status === 429 || err.status >= 500) {
        console.warn(`Config ${id}: skipped a post (${err.message})`);
        return;
      }
      console.error(`Config ${id} stopped:`, err.message);
      stopRunner(id);
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = `Stopped automatically: Failed to post via user token in <#${currentConfig.channelId}>.`;
      save();
      refreshCard(id).catch(() => {});
    }
  };

  if (immediate) tick();
  timers.set(id, setInterval(tick, c.delay * 1000));
}

async function validate(field, raw, guildId, userId) {
  if (field === 'name') {
    return raw ? { value: raw.slice(0, 50) } : { error: 'The name can\'t be empty.' };
  }
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'That doesn\'t look like a channel ID.' };
    try {
      const userCreds = store.credentials[userId];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

      const ch = await DiscordRequest(`channels/${raw}`, { token: activeToken });
      if (![0, 5].includes(ch.type)) return { error: 'Please pick a text channel.' };
    } catch {
      return { error: 'I can\'t find that channel or your user token lacks access to it.' };
    }
    return { value: raw };
  }
  if (field === 'text') {
    return raw ? { value: raw } : { error: 'The text can\'t be empty.' };
  }
  return { error: 'Unknown field.' };
}

function parseDelay(v) {
  const parts = ['hours', 'minutes', 'seconds'].map((k) => (v[k] ?? '').trim());
  if (parts.some((p) => p && !/^\d+$/.test(p)))
    return { error: 'Please use whole numbers only.' };
  const [h, m, s] = parts.map((p) => Number(p || 0));
  const total = h * 3600 + m * 60 + s;
  if (total < MIN_DELAY || total > MAX_DELAY)
    return { error: `Delay must be between ${fmtDelay(MIN_DELAY)} and ${fmtDelay(MAX_DELAY)}.` };
  return { value: total };
}

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

async function handle(req, res) {
  const { type, data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'help') return reply(res, { embeds: [helpEmbed()] });
    if (!guildId) return ephemeral(res, '⚠️ This command only works inside a server.');

    if (name === 'add-token') {
      const actionOption = data.options?.find((o) => o.name === 'action')?.value;

      if (actionOption === 'register') {
        return res.send(credentialInputModal());
      }

      if (actionOption === 'list') {
        const userCreds = Object.entries(store.credentials[user.id] || {});
        if (!userCreds.length) {
          return notice(res, COLOR.blurple, '🔐 Stored User Tokens', 'You have no registered user tokens yet. Run `/add-token register` first.');
        }
        const fields = userCreds.map(([label, cred]) => ({
          name: `🏷️ ${label}`,
          value: `Registered: <t:${unix(cred.createdAt)}:R>\nFingerprint: \`${cred.redacted}\``,
        }));
        return reply(res, { embeds: [{ color: COLOR.blurple, title: '🔐 Registered User Tokens', fields }] });
      }

      if (actionOption === 'remove') {
        const userCreds = Object.keys(store.credentials[user.id] || {});
        if (!userCreds.length) return ephemeral(res, '⚠️ You have no stored tokens to remove.');
        return reply(res, {
          content: '🗑️ Select a token to remove from secure storage:',
          components: [
            row(
              ...userCreds.slice(0, 5).map((label) => btn(`cred:remove:${label}`, label, DANGER))
            ),
          ],
        });
      }
    }

    if (name === 'status') {
      const mine = mineOf(guildId, user.id);
      const hasToken = Boolean(Object.keys(store.credentials[user.id] || {}).length);
      const startedAt = Date.now() - process.uptime() * 1000;
      return reply(res, {
        embeds: [{
          color: COLOR.green,
          title: '✅ Bot Status & Authentication',
          fields: [
            { name: 'User Token Registered', value: hasToken ? '✅ Yes' : '❌ No (Required for configs)', inline: true },
            { name: 'Your Configs', value: String(mine.length), inline: true },
            { name: 'Running', value: String(mine.filter(([, c]) => c.running).length), inline: true },
          ],
        }],
      });
    }

    if (name === 'list-configs') {
      const mine = mineOf(guildId, user.id);
      if (!mine.length)
        return notice(res, COLOR.blurple, '📭 No configs yet', 'Run `/add-config` to create your first one.');
      const ctrl = store.users[`${guildId}:${user.id}`]?.controllerChannelId;
      return reply(res, {
        embeds: [{
          color: COLOR.blurple,
          title: `📋 Your configs (${mine.length}/${MAX_CONFIGS})`,
          description: ctrl ? `Manage them in <#${ctrl}>.` : undefined,
          fields: mine.map(([, c]) => ({
            name: `${c.running ? '🟢' : '🔴'} ${clip(c.name, 200)}`,
            value: `<#${c.channelId}> · every ${fmtDelay(c.delay)} · ${c.sent ?? 0} posts`,
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
          content: `📂 Your controller channel: <#${controllerId}>` + (restored ? `\n🔧 Restored ${restored} missing config card${restored === 1 ? '' : 's'}.` : ''),
        });
      } catch (err) {
        console.error(err);
        await editOriginal(token, { content: '⚠️ I couldn\'t open your controller channel.' }).catch(() => {});
      }
      return;
    }

    if (name === 'stop-all') {
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
      const running = mineOf(guildId, user.id).filter(([, c]) => c.running);
      for (const [id, c] of running) {
        stopRunner(id);
        c.running = false;
        c.startedAt = null;
      }
      if (running.length) save();
      await Promise.allSettled(running.map(([id]) => refreshCard(id)));
      await editOriginal(token, {
        content: running.length ? `⏹️ Stopped ${running.length} running config${running.length === 1 ? '' : 's'}.` : 'Nothing was running.',
      }).catch(() => {});
      return;
    }

    if (name === 'add-config') {
      const userTokens = Object.keys(store.credentials[user.id] || {});
      if (!userTokens.length) {
        return notice(
          res,
          COLOR.red,
          '⚠️ Token Required',
          'You must register your Discord user account token before creating an automation configuration.\n\nRun `/add-token register` first.'
        );
      }

      const cfgName = data.options[0].value.trim().slice(0, 50);
      if (!cfgName) return ephemeral(res, '⚠️ Please give your config a name.');

      const saved = mineOf(guildId, user.id).length;
      const open = Object.values(store.drafts).filter((d) => d.userId === user.id && d.guildId === guildId).length;
      if (saved + open >= MAX_CONFIGS)
        return notice(res, COLOR.red, 'Limit reached', `You can have up to **${MAX_CONFIGS}** configs.`);
      if (open >= MAX_OPEN_SETUPS)
        return notice(res, COLOR.red, 'Finish your other setups first', `You already have ${open} unfinished setups.`);

      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
      try {
        const controllerId = await ensureController(guildId, user);
        await repostCards(guildId, user.id, controllerId);
        const setup = await DiscordRequest(`guilds/${guildId}/channels`, {
          method: 'POST',
          body: {
            name: `setup-${slug(cfgName)}`,
            type: 0,
            topic: 'Private setup for a new config.',
            permission_overwrites: privateOverwrites(guildId, user.id),
          },
        });
        const draft = {
          userId: user.id, username: user.username, guildId, name: cfgName,
          channelId: null, text: null, delay: null, createdAt: Date.now(),
        };
        store.drafts[setup.id] = draft;
        save();
        await DiscordRequest(`channels/${setup.id}/messages`, {
          method: 'POST',
          body: { ...setupPanel(setup.id, draft), content: `<@${user.id}> your setup is ready!`, allowed_mentions: { users: [user.id] } },
        });
        await editOriginal(token, {
          content: '',
          embeds: [{
            color: COLOR.green,
            title: '✅ Setup channel ready',
            description: `Continue in <#${setup.id}>.\nYour control panel: <#${controllerId}>`,
          }],
        });
      } catch (err) {
        console.error(err);
        await editOriginal(token, {
          content: '',
          embeds: [{ color: COLOR.red, title: '⚠️ Setup creation failed', description: 'Check bot permissions.' }],
        }).catch(() => {});
      }
      return;
    }
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const [action, ...p] = data.custom_id.split(':');

    if (action === 'cred' && p[0] === 'remove') {
      const label = p[1];
      if (store.credentials[user.id]?.[label]) {
        delete store.credentials[user.id][label];
        save();
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: `🗑️ Successfully removed token label: **${label}** from secure storage.`, embeds: [], components: [] },
        });
      }
      return ephemeral(res, '⚠️ Token not found.');
    }

    if (action === 'delete_no') {
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: 'Okay, nothing was deleted.', embeds: [], components: [] },
      });
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
      save();
      res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: '',
          embeds: [{ color: COLOR.grey, title: 'Setup cancelled', description: 'This channel will be deleted in 5 seconds…' }],
          components: [],
        },
      });
      setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(console.error), 5000);
      return;
    }

    if (action === 'confirm') {
      const [id] = p;
      const d = store.drafts[id];
      if (!d || d.userId !== user.id) return notYours(res);
      if (!(d.channelId && d.text && d.delay)) return ephemeral(res, '⚠️ Please fill in all three settings first.');

      res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
      try {
        const controllerId = await ensureController(d.guildId, { id: d.userId, username: d.username });
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
        save();

        await editOriginal(token, {
          content: '',
          embeds: [{
            color: COLOR.green,
            title: `✅ “${d.name}” saved!`,
            description: `Find it in <#${controllerId}> and press **Start** when you're ready.\nThis channel will be deleted in 5 seconds…`,
          }],
          components: [],
        });
        setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(console.error), 5000);
      } catch (err) {
        console.error(err);
        delete store.configs[id];
        await editOriginal(token, {
          ...setupPanel(id, d),
          content: '⚠️ I couldn\'t save the config.',
        }).catch(() => {});
      }
      return;
    }

    const cfgId = p[0];
    const cfg = store.configs[cfgId];
    if (!cfg || cfg.userId !== user.id) return notYours(res);

    if (action === 'edit') {
      return reply(res, {
        content: `✏️ What would you like to change in **${cfg.name}**?`,
        components: [
          row(
            btn(`set:cfg:${cfgId}:name`, 'Rename'),
            btn(`set:cfg:${cfgId}:channelId`, 'Set channel ID'),
            btn(`set:cfg:${cfgId}:text`, 'Set text'),
            btn(`set:cfg:${cfgId}:delay`, 'Set delay timer'),
          ),
        ],
      });
    }

    if (action === 'toggle') {
      cfg.running = !cfg.running;
      cfg.lastError = null;
      cfg.startedAt = cfg.running ? Date.now() : null;
      save();
      res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
      if (cfg.running) startRunner(cfgId);
      else stopRunner(cfgId);
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
          await editOriginal(token, { content: '⚠️ No registered user token found. Use `/add-token register` first.' });
          return;
        }

        await DiscordRequest(`channels/${cfg.channelId}/messages`, {
          method: 'POST',
          token: activeToken,
          body: { content: cfg.text, allowed_mentions: NO_PINGS },
        });
        await editOriginal(token, { content: `🧪 Sent test message via user token to <#${cfg.channelId}>.` });
      } catch (err) {
        console.error(err);
        await editOriginal(token, { content: `⚠️ Failed to test post via user token. Check channel permissions.` }).catch(() => {});
      }
      return;
    }

    if (action === 'delete') {
      return reply(res, {
        content: `🗑️ Delete **${cfg.name}**? This can't be undone.`,
        components: [row(btn(`delete_yes:${cfgId}`, 'Yes, delete', DANGER), btn('delete_no', 'Cancel'))],
      });
    }

    if (action === 'delete_yes') {
      stopRunner(cfgId);
      delete store.configs[cfgId];
      save();
      res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: `🗑️ Deleted **${cfg.name}**.`, embeds: [], components: [] },
      });
      DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
  }

  if (type === InteractionType.MODAL_SUBMIT) {
    if (data.custom_id === 'modal:add-token:save') {
      const values = Object.fromEntries(
        data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']),
      );
      const label = (values.label_name || 'default').trim();
      const rawToken = (values.token_value || '').trim();

      if (!rawToken) return ephemeral(res, '⚠️ Token cannot be empty.');

      const encrypted = encryptCredential(rawToken);
      const redacted = redactToken(rawToken);

      store.credentials[user.id] ??= {};
      store.credentials[user.id][label] = {
        encrypted,
        redacted,
        createdAt: Date.now(),
      };
      save();

      return ephemeral(res, `✅ User account token securely stored under label **${label}**.\nRedacted fingerprint: \`${redacted}\`\n*(You can now create automation configs using \`/add-config\`)*.`);
    }

    const [, mode, id, field] = data.custom_id.split(':');
    const target = lookup(mode, id);
    if (!target || target.userId !== user.id) return notYours(res);

    const values = Object.fromEntries(
      data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']),
    );
    const result = field === 'delay'
      ? parseDelay(values)
      : await validate(field, (values.value ?? '').trim(), target.guildId, user.id); // Passed user.id here
    if (result.error) return ephemeral(res, `⚠️ ${result.error}`);

    target[field] = result.value;
    save();

    if (mode === 'draft') {
      return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: setupPanel(id, target) });
    }

    if (field === 'delay' && target.running) startRunner(id, false);
    if (field === 'channelId') target.lastError = null;
    refreshCard(id).catch(console.error);
    return ephemeral(res, '✅ Updated! Your controller card has been refreshed.');
  }

  console.error('Unhandled interaction type', type);
  return res.status(400).json({ error: 'unknown interaction' });
}

app.get('/health', (req, res) => res.send('ok'));

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), (req, res) => {
  handle(req, res).catch((err) => {
    console.error('Interaction error:', err);
    if (!res.headersSent) ephemeral(res, '⚠️ Something went wrong. Please try again.');
  });
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

async function sweepDrafts() {
  const now = Date.now();
  let changed = false;
  for (const [id, d] of Object.entries(store.drafts)) {
    d.createdAt ??= now;
    if (now - d.createdAt > DRAFT_TTL) {
      delete store.drafts[id];
      changed = true;
      DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  if (changed) save();
}

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  for (const [id, c] of Object.entries(store.configs)) if (c.running) startRunner(id, false);
  sweepDrafts();
  setInterval(sweepDrafts, 60 * 60 * 1000);
});