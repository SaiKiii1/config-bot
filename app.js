import 'dotenv/config';
import express from 'express';
import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { DiscordRequest, loadStore, saveStore, slug, privateOverwrites } from './utils.js';

const app = express();
const PORT = process.env.PORT || 3000;

const store = await loadStore();
store.users ??= {};
store.drafts ??= {};
store.configs ??= {};
const save = () => saveStore(store);
const timers = new Map(); // configId -> setInterval handle

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
const MIN_DELAY = 5; // seconds
const MAX_DELAY = 86400; // 24 hours
const MAX_CONFIGS = 10; // per person, per server
const MAX_OPEN_SETUPS = 3; // unfinished setups per person
const DRAFT_TTL = 24 * 60 * 60 * 1000; // abandoned setups are cleaned up after 24h

const COLOR = { blurple: 0x5865f2, green: 0x57f287, red: 0xed4245, grey: 0x4f545c };
const PRIMARY = 1, SECONDARY = 2, SUCCESS = 3, DANGER = 4;
const NO_PINGS = { parse: [] }; // stops @everyone / role pings inside user text

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
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
const fmtShort = (s) => (s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`);

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

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */
const FIELDS = {
  name: { title: 'Rename config', label: 'Config name', style: 1, max: 50, placeholder: 'e.g. Daily reminder' },
  channelId: { title: 'Set channel ID', label: 'Channel ID', style: 1, max: 20, placeholder: 'e.g. 123456789012345678' },
  text: { title: 'Set text', label: 'Message text', style: 2, max: 1000, placeholder: 'What should I post?' },
  delay: { title: 'Set delay timer', label: 'Delay (e.g. 30s, 5m, 2h)', style: 1, max: 8, placeholder: '30s, 5m or 2h' },
};

function modal(mode, id, field, current) {
  const f = FIELDS[field];
  const value = current == null ? undefined : field === 'delay' ? fmtShort(current) : String(current);
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

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */
/** Shown inside the private setup channel */
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
      footer: { text: '🔒 Private channel — only you can see it.' },
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

/** One card per saved config, shown in the controller channel */
function cardPanel(id, c) {
  const status = c.running
    ? `🟢 **Running**${c.startedAt ? ` · started <t:${unix(c.startedAt)}:R>` : ''}`
    : '🔴 **Stopped**';
  return {
    content: '',
    embeds: [{
      title: `📌 ${c.name}`,
      description: status + (c.lastError ? `\n⚠️ ${c.lastError}` : ''),
      color: c.lastError ? COLOR.red : c.running ? COLOR.green : COLOR.grey,
      fields: [
        { name: '📍 Channel', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ Delay', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 Posts sent', value: String(c.sent ?? 0), inline: true },
        { name: '🕒 Last post', value: c.lastSentAt ? `<t:${unix(c.lastSentAt)}:R>` : '—', inline: true },
        { name: '💬 Text', value: quote(c.text) },
      ],
      footer: { text: 'Stats refresh when you press a button — use 🔄 to see the latest.' },
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
  title: '🤖 Config Bot — Help',
  description: 'I post a message you choose into a channel you choose, on a timer you choose.',
  fields: [
    {
      name: 'Commands',
      value:
        '`/add-config name` — create a new config\n' +
        '`/list-configs` — see all your configs\n' +
        '`/controller` — open or repair your control panel\n' +
        '`/stop-all` — stop everything you have running\n' +
        '`/status` — check that I\'m online\n' +
        '`/help` — this message',
    },
    {
      name: 'How it works',
      value:
        '1️⃣ Run `/add-config` — I create a private **setup** channel for you.\n' +
        '2️⃣ Set the channel ID, text and delay, then press **Confirm**.\n' +
        '3️⃣ Your config shows up in your private **controller** channel.\n' +
        '4️⃣ There you can ▶️ Start / ⏹️ Stop, ✏️ Edit, 🧪 Test or 🗑️ Delete it.',
    },
    {
      name: 'Good to know',
      value:
        `• Delay: ${fmtDelay(MIN_DELAY)} to ${fmtDelay(MAX_DELAY)} (type \`30s\`, \`5m\` or \`2h\`)\n` +
        `• Up to ${MAX_CONFIGS} configs per person\n` +
        '• The target channel must be in this server, and I need permission to post there',
    },
  ],
});

/* ------------------------------------------------------------------ */
/* Controller channel                                                  */
/* ------------------------------------------------------------------ */
async function ensureController(guildId, user) {
  const key = `${guildId}:${user.id}`;
  const existing = store.users[key]?.controllerChannelId;
  if (existing) {
    try {
      await DiscordRequest(`channels/${existing}`);
      return existing;
    } catch (e) {
      if (e.status !== 404) throw e; // deleted manually -> recreate below
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

/** Re-posts any config card that went missing (e.g. someone deleted the controller channel). */
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
/* Runner: posts c.text into c.channelId every c.delay seconds         */
/* ------------------------------------------------------------------ */
function stopRunner(id) {
  clearInterval(timers.get(id));
  timers.delete(id);
}

function startRunner(id, immediate = true) {
  stopRunner(id);
  if (!store.configs[id]) return;

  const tick = async () => {
    const c = store.configs[id];
    if (!c) return stopRunner(id);
    try {
      await DiscordRequest(`channels/${c.channelId}/messages`, {
        method: 'POST',
        body: { content: c.text, allowed_mentions: NO_PINGS },
      });
      c.sent = (c.sent ?? 0) + 1;
      c.lastSentAt = Date.now();
      if (c.sent % 10 === 0) save(); // don't hit the database on every single post
    } catch (err) {
      // temporary problems (rate limit, Discord hiccup, network): skip this round, keep running
      if (!err.status || err.status === 429 || err.status >= 500) {
        console.warn(`Config ${id}: skipped a post (${err.message})`);
        return;
      }
      console.error(`Config ${id} stopped:`, err.message);
      stopRunner(id);
      c.running = false;
      c.startedAt = null;
      c.lastError = `Stopped automatically: I couldn't post in <#${c.channelId}>. Check that I can view and send messages there, then press Start.`;
      save();
      refreshCard(id).catch(() => {});
    }
  };

  if (immediate) tick();
  timers.set(id, setInterval(tick, store.configs[id].delay * 1000));
}

/* ------------------------------------------------------------------ */
/* Validation for modal input                                          */
/* ------------------------------------------------------------------ */
async function validate(field, raw, guildId) {
  if (field === 'name') {
    return raw ? { value: raw.slice(0, 50) } : { error: 'The name can\'t be empty.' };
  }
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'That doesn\'t look like a channel ID — it should be a long number.' };
    try {
      const ch = await DiscordRequest(`channels/${raw}`);
      if (ch.guild_id !== guildId) return { error: 'That channel isn\'t in this server.' };
      if (![0, 5].includes(ch.type)) return { error: 'Please pick a text channel.' };
    } catch {
      return { error: 'I can\'t find that channel — or I don\'t have access to it.' };
    }
    return { value: raw };
  }
  if (field === 'text') {
    return raw ? { value: raw } : { error: 'The text can\'t be empty.' };
  }
  if (field === 'delay') {
    const m = raw.toLowerCase().replace(/\s+/g, '').match(/^(\d+)(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
    if (!m) return { error: 'Use a number with an optional unit, like `30`, `30s`, `5m` or `2h`.' };
    const unit = m[2] ?? 's';
    const n = Number(m[1]) * (unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : 3600);
    if (n < MIN_DELAY || n > MAX_DELAY)
      return { error: `The delay must be between ${fmtDelay(MIN_DELAY)} and ${fmtDelay(MAX_DELAY)}.` };
    return { value: n };
  }
  return { error: 'Unknown field.' };
}

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

/* ------------------------------------------------------------------ */
/* Interaction handler                                                 */
/* ------------------------------------------------------------------ */
async function handle(req, res) {
  const { type, data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;

  /* ---------------- slash commands ---------------- */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'help') return reply(res, { embeds: [helpEmbed()] });
    if (!guildId) return ephemeral(res, '⚠️ This command only works inside a server.');

    if (name === 'status') {
      const mine = mineOf(guildId, user.id);
      const startedAt = Date.now() - process.uptime() * 1000;
      return reply(res, {
        embeds: [{
          color: COLOR.green,
          title: '✅ I\'m online',
          fields: [
            { name: 'Up since', value: `<t:${unix(startedAt)}:R>`, inline: true },
            { name: 'Your configs', value: String(mine.length), inline: true },
            { name: 'Your running configs', value: String(mine.filter(([, c]) => c.running).length), inline: true },
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
        await editOriginal(token, { content: '⚠️ I couldn\'t open your controller channel. Check my permissions (Manage Channels, Manage Roles).' }).catch(() => {});
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
      const cfgName = data.options[0].value.trim().slice(0, 50);
      if (!cfgName) return ephemeral(res, '⚠️ Please give your config a name.');

      const saved = mineOf(guildId, user.id).length;
      const open = Object.values(store.drafts).filter((d) => d.userId === user.id && d.guildId === guildId).length;
      if (saved + open >= MAX_CONFIGS)
        return notice(res, COLOR.red, 'Limit reached', `You can have up to **${MAX_CONFIGS}** configs. Delete one in your controller channel first.`);
      if (open >= MAX_OPEN_SETUPS)
        return notice(res, COLOR.red, 'Finish your other setups first', `You already have ${open} unfinished setups. Complete or cancel one (look for your \`setup-…\` channels) before starting another.`);

      // Acknowledge now (3s limit), do the slow channel work afterwards.
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: InteractionResponseFlags.EPHEMERAL } });
      try {
        const controllerId = await ensureController(guildId, user);
        await repostCards(guildId, user.id, controllerId);
        const setup = await DiscordRequest(`guilds/${guildId}/channels`, {
          method: 'POST',
          body: {
            name: `setup-${slug(cfgName)}`,
            type: 0,
            topic: 'Private setup for a new config. This channel deletes itself when you finish.',
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
          embeds: [{
            color: COLOR.red,
            title: '⚠️ I couldn\'t create your setup channel',
            description: 'Make sure I have **Manage Channels**, **Manage Roles**, **View Channels**, **Send Messages** and **Read Message History**, and that the server has room for more channels.',
          }],
        }).catch(() => {});
      }
      return;
    }
  }

  /* ---------------- buttons ---------------- */
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const [action, ...p] = data.custom_id.split(':');

    if (action === 'delete_no') {
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: 'Okay, nothing was deleted.', embeds: [], components: [] },
      });
    }

    // set:<draft|cfg>:<id>:<field>  -> open modal
    if (action === 'set') {
      const [mode, id, field] = p;
      const target = lookup(mode, id);
      if (!target || target.userId !== user.id) return notYours(res);
      return res.send(modal(mode, id, field, target[field]));
    }

    // setup panel: cancel
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

    // setup panel: confirm
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
          content: '⚠️ I couldn\'t save the config. Please press **Confirm** again.',
        }).catch(() => {});
      }
      return;
    }

    // controller card buttons
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
        await DiscordRequest(`channels/${cfg.channelId}/messages`, {
          method: 'POST',
          body: { content: cfg.text, allowed_mentions: NO_PINGS },
        });
        await editOriginal(token, { content: `🧪 Sent a test message to <#${cfg.channelId}>.` });
      } catch (err) {
        console.error(err);
        await editOriginal(token, { content: `⚠️ I couldn't post in <#${cfg.channelId}>. Check that I can view and send messages there.` }).catch(() => {});
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

  /* ---------------- modal submits ---------------- */
  if (type === InteractionType.MODAL_SUBMIT) {
    const [, mode, id, field] = data.custom_id.split(':');
    const target = lookup(mode, id);
    if (!target || target.userId !== user.id) return notYours(res);

    const raw = data.components[0].components[0].value.trim();
    const result = await validate(field, raw, target.guildId);
    if (result.error) return ephemeral(res, `⚠️ ${result.error}`);

    target[field] = result.value;
    save();

    if (mode === 'draft') {
      // refresh the setup panel in place
      return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: setupPanel(id, target) });
    }

    if (field === 'delay' && target.running) startRunner(id, false); // apply the new delay
    if (field === 'channelId') target.lastError = null;
    refreshCard(id).catch(console.error);
    return ephemeral(res, '✅ Updated! Your controller card has been refreshed.');
  }

  console.error('Unhandled interaction type', type);
  return res.status(400).json({ error: 'unknown interaction' });
}

// Health check: Render + an uptime pinger hit this to keep the free service awake.
app.get('/health', (req, res) => res.send('ok'));

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), (req, res) => {
  handle(req, res).catch((err) => {
    console.error('Interaction error:', err);
    if (!res.headersSent) ephemeral(res, '⚠️ Something went wrong. Please try again.');
  });
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */
/** Deletes setup channels that were abandoned for more than 24 hours. */
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
  // Resume anything that was running before a restart (no instant send).
  for (const [id, c] of Object.entries(store.configs)) if (c.running) startRunner(id, false);
  sweepDrafts();
  setInterval(sweepDrafts, 60 * 60 * 1000);
});