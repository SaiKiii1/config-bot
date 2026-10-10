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

const store = loadStore();
const save = () => saveStore(store);
const timers = new Map(); // configId -> setInterval handle

const MIN_DELAY = 5; // seconds
const MAX_DELAY = 86400;

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */
const row = (...components) => ({ type: 1, components });
const btn = (custom_id, label, style = 2, disabled = false) => ({
  type: 2, custom_id, label, style, disabled,
});
const PRIMARY = 1, SECONDARY = 2, SUCCESS = 3, DANGER = 4;

const NO_PINGS = { parse: [] }; // stops @everyone / role pings inside user text

const ephemeral = (res, content, components) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content, components, allowed_mentions: NO_PINGS },
  });

const FIELDS = {
  channelId: { title: 'Set channel ID', label: 'Channel ID', style: 1, max: 20, placeholder: 'e.g. 123456789012345678' },
  text: { title: 'Set text', label: 'Message text', style: 2, max: 1000, placeholder: 'What should the bot send?' },
  delay: { title: 'Set delay timer', label: `Delay in seconds (${MIN_DELAY}-${MAX_DELAY})`, style: 1, max: 6, placeholder: 'e.g. 60' },
};

function modal(mode, id, field, current) {
  const f = FIELDS[field];
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:${field}`,
      title: f.title,
      components: [
        row({
          type: 4, // text input
          custom_id: 'value',
          label: f.label,
          style: f.style,
          min_length: 1,
          max_length: f.max,
          required: true,
          placeholder: f.placeholder,
          ...(current != null ? { value: String(current) } : {}),
        }),
      ],
    },
  };
}

const quote = (t) => t.split('\n').map((l) => `> ${l}`).join('\n');

/** The panel shown inside the private #setup channel */
function setupPanel(id, d) {
  const complete = d.channelId && d.text && d.delay;
  return {
    content:
      `## ⚙️ Setting up: **${d.name}**\n` +
      `Use the buttons to fill in each setting, then press **Confirm**.\n\n` +
      `**Channel:** ${d.channelId ? `<#${d.channelId}>` : '*not set*'}\n` +
      `**Delay:** ${d.delay ? `every ${d.delay}s` : '*not set*'}\n` +
      `**Text:** ${d.text ? `\n${quote(d.text)}` : '*not set*'}`,
    components: [
      row(
        btn(`set:draft:${id}:channelId`, 'Set channel ID', SECONDARY),
        btn(`set:draft:${id}:text`, 'Set text', SECONDARY),
        btn(`set:draft:${id}:delay`, 'Set delay timer', SECONDARY),
        btn(`confirm:${id}`, 'Confirm', SUCCESS, !complete),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

/** The card shown in the controller channel for each saved config */
function cardPanel(id, c) {
  return {
    content:
      `### 📌 ${c.name}\n` +
      `**Channel:** <#${c.channelId}>\n` +
      `**Delay:** every ${c.delay}s\n` +
      `**Status:** ${c.running ? '🟢 Running' : '🔴 Stopped'}` +
      (c.lastError ? `\n⚠️ ${c.lastError}` : '') +
      `\n**Text:**\n${quote(c.text)}`,
    components: [
      row(
        btn(`edit:${id}`, 'Edit', PRIMARY),
        btn(`toggle:${id}`, c.running ? 'Stop' : 'Start', c.running ? DANGER : SUCCESS),
        btn(`delete:${id}`, 'Delete', DANGER),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

const refreshCard = (id) => {
  const c = store.configs[id];
  if (!c?.cardMessageId) return Promise.resolve();
  return DiscordRequest(`channels/${c.controllerChannelId}/messages/${c.cardMessageId}`, {
    method: 'PATCH',
    body: cardPanel(id, c),
  });
};

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
      topic: 'Control panel for your configurations (edit / start / stop / delete).',
      permission_overwrites: privateOverwrites(guildId, user.id),
    },
  });
  store.users[key] = { controllerChannelId: ch.id };
  save();
  return ch.id;
}

/* ------------------------------------------------------------------ */
/* Runner: posts cfg.text into cfg.channelId every cfg.delay seconds   */
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
    } catch (err) {
      console.error(`Config ${id} stopped:`, err.message);
      stopRunner(id);
      c.running = false;
      c.lastError = `Stopped: couldn't send to <#${c.channelId}> (check the bot's permissions).`;
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
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'That doesn\'t look like a channel ID.' };
    try {
      const ch = await DiscordRequest(`channels/${raw}`);
      if (ch.guild_id !== guildId) return { error: 'That channel is not in this server.' };
      if (![0, 5].includes(ch.type)) return { error: 'Please pick a text channel.' };
    } catch {
      return { error: 'I can\'t find that channel (or I can\'t see it).' };
    }
    return { value: raw };
  }
  if (field === 'text') {
    return raw ? { value: raw } : { error: 'Text can\'t be empty.' };
  }
  if (field === 'delay') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_DELAY || n > MAX_DELAY)
      return { error: `Delay must be a whole number between ${MIN_DELAY} and ${MAX_DELAY} seconds.` };
    return { value: n };
  }
  return { error: 'Unknown field.' };
}

const lookup = (mode, id) => (mode === 'draft' ? store.drafts[id] : store.configs[id]);

/* ------------------------------------------------------------------ */
/* Interactions endpoint                                               */
/* ------------------------------------------------------------------ */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async (req, res) => {
  const { type, data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;

  /* ---------------- slash commands ---------------- */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'help') {
      return ephemeral(
        res,
        '## 🤖 Help\n' +
          '**/help** – show this message\n' +
          '**/add-config `name`** – create a new configuration\n\n' +
          '**How it works**\n' +
          '1. Run `/add-config`. I create a private **setup** channel and (if you don\'t have one) a private **controller** channel.\n' +
          '2. In the setup channel, press **Set channel ID**, **Set text** and **Set delay timer**, then **Confirm**.\n' +
          '3. The setup channel deletes itself after 5 seconds and your config appears in the controller channel.\n' +
          '4. In the controller, use **Edit**, **Start / Stop** and **Delete**. When running, I post your text in the chosen channel every N seconds.',
      );
    }

    if (name === 'add-config') {
      if (!guildId) return ephemeral(res, '⚠️ This command only works in a server.');
      const cfgName = data.options[0].value.trim().slice(0, 50);

      // Acknowledge now (3s limit), do the slow channel work afterwards.
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      try {
        const controllerId = await ensureController(guildId, user);
        const setup = await DiscordRequest(`guilds/${guildId}/channels`, {
          method: 'POST',
          body: {
            name: `setup-${slug(cfgName)}`,
            type: 0,
            permission_overwrites: privateOverwrites(guildId, user.id),
          },
        });
        const draft = {
          userId: user.id, username: user.username, guildId, name: cfgName,
          channelId: null, text: null, delay: null,
        };
        store.drafts[setup.id] = draft;
        save();
        await DiscordRequest(`channels/${setup.id}/messages`, { method: 'POST', body: setupPanel(setup.id, draft) });
        await editOriginal(token, {
          content: `✅ Head to <#${setup.id}> to finish setting up **${cfgName}**.\nYour controller: <#${controllerId}>`,
        });
      } catch (err) {
        console.error(err);
        await editOriginal(token, {
          content: '⚠️ Something went wrong. Make sure I have **Manage Channels**, **Manage Roles**, **View Channel**, **Send Messages** and **Read Message History**.',
        }).catch(() => {});
      }
      return;
    }
  }

  /* ---------------- buttons ---------------- */
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const [action, ...p] = data.custom_id.split(':');

    // set:<draft|cfg>:<id>:<field>  -> open modal
    if (action === 'set') {
      const [mode, id, field] = p;
      const target = lookup(mode, id);
      if (!target || target.userId !== user.id) return ephemeral(res, '⚠️ This config no longer exists or isn\'t yours.');
      return res.send(modal(mode, id, field, target[field]));
    }

    // confirm:<draftId>
    if (action === 'confirm') {
      const [id] = p;
      const d = store.drafts[id];
      if (!d || d.userId !== user.id) return ephemeral(res, '⚠️ This setup isn\'t yours.');
      if (!(d.channelId && d.text && d.delay)) return ephemeral(res, '⚠️ Please fill in every setting first.');

      res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
      try {
        const controllerId = await ensureController(d.guildId, { id: d.userId, username: d.username });
        const cfg = {
          userId: d.userId, guildId: d.guildId, name: d.name,
          channelId: d.channelId, text: d.text, delay: d.delay,
          running: false, lastError: null,
          controllerChannelId: controllerId, cardMessageId: null,
        };
        store.configs[id] = cfg;
        const msg = await DiscordRequest(`channels/${controllerId}/messages`, { method: 'POST', body: cardPanel(id, cfg) });
        cfg.cardMessageId = msg.id;
        delete store.drafts[id];
        save();

        await editOriginal(token, {
          content: `✅ **${d.name}** saved! It's now in <#${controllerId}>.\nThis channel will be deleted in 5 seconds…`,
          components: [],
        });
        setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(console.error), 5000);
      } catch (err) {
        console.error(err);
        delete store.configs[id];
        await editOriginal(token, { content: '⚠️ Couldn\'t save the config. Please try Confirm again.', components: setupPanel(id, d).components }).catch(() => {});
      }
      return;
    }

    // controller card buttons
    const cfgId = p[0];
    const cfg = store.configs[cfgId];
    if (!cfg || cfg.userId !== user.id) return ephemeral(res, '⚠️ This config no longer exists or isn\'t yours.');

    if (action === 'edit') {
      return ephemeral(res, `✏️ What do you want to change in **${cfg.name}**?`, [
        row(
          btn(`set:cfg:${cfgId}:channelId`, 'Set channel ID', SECONDARY),
          btn(`set:cfg:${cfgId}:text`, 'Set text', SECONDARY),
          btn(`set:cfg:${cfgId}:delay`, 'Set delay timer', SECONDARY),
        ),
      ]);
    }

    if (action === 'toggle') {
      cfg.running = !cfg.running;
      cfg.lastError = null;
      save();
      res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
      if (cfg.running) startRunner(cfgId);
      else stopRunner(cfgId);
      return;
    }

    if (action === 'delete') {
      stopRunner(cfgId);
      delete store.configs[cfgId];
      save();
      ephemeral(res, `🗑️ **${cfg.name}** deleted.`);
      DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
  }

  /* ---------------- modal submits ---------------- */
  if (type === InteractionType.MODAL_SUBMIT) {
    const [, mode, id, field] = data.custom_id.split(':');
    const target = lookup(mode, id);
    if (!target || target.userId !== user.id) return ephemeral(res, '⚠️ This config no longer exists or isn\'t yours.');

    const raw = data.components[0].components[0].value.trim();
    const result = await validate(field, raw, target.guildId);
    if (result.error) return ephemeral(res, `⚠️ ${result.error}`);

    target[field] = result.value;
    save();

    if (mode === 'draft') {
      // refresh the setup panel in place
      return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: setupPanel(id, target) });
    }

    if (field === 'delay' && target.running) startRunner(id, false); // apply new delay
    refreshCard(id).catch(console.error);
    return ephemeral(res, '✅ Updated.');
  }

  console.error('Unhandled interaction', type);
  return res.status(400).json({ error: 'unknown interaction' });
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  // Resume anything that was running before a restart (no instant send).
  for (const [id, c] of Object.entries(store.configs)) if (c.running) startRunner(id, false);
});
