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

const COLOR = { blurple: 0x5865f2, green: 0x57f287, amber: 0xfee75c, red: 0xed4245, dark: 0x2f3136 };
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
const notYours = (res) => ephemeral(res, '🛡️ **Access Denied**: This configuration no longer exists or belongs to another security profile.');

const editOriginal = (token, body) =>
  DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, { method: 'PATCH', body });

const mineOf = (guildId, userId) =>
  Object.entries(store.configs).filter(([, c]) => c.userId === userId && c.guildId === guildId);

const FIELDS = {
  name: { title: '✏️ Rename Configuration', label: 'Configuration Name', style: 1, max: 50, placeholder: 'e.g., Enterprise Notice Broadcast' },
  channelId: { title: '📍 Configure Target Channel ID', label: 'Destination Channel ID', style: 1, max: 20, placeholder: 'e.g., 123456789012345678' },
  text: { title: '💬 Define Dispatch Payload', label: 'Message Body', style: 2, max: 1000, placeholder: 'Enter markdown-formatted payload...' },
  delay: { title: '⏱️ Set Execution Interval' },
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
      components: [input('hours', 'Hours (0-24)', '0'), input('minutes', 'Minutes (0-59)', '0'), input('seconds', 'Seconds (5-59)', '30')],
    },
  };
}

function credentialInputModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'modal:add-token:save',
      title: '🔐 Secure Credential Registration (Limit: 1)',
      components: [
        row({
          type: 4,
          custom_id: 'label_name',
          label: 'Token Profile Label',
          style: 1,
          required: true,
          max_length: 50,
          placeholder: 'e.g., My-Primary-Account',
        }),
        row({
          type: 4,
          custom_id: 'token_value',
          label: 'Discord Account Session Token',
          style: 1,
          required: true,
          min_length: 50,
          max_length: 200,
          placeholder: 'Paste session credential (encrypted at rest)',
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
  const mark = (v) => (v ? '🟢' : '⚪');
  return {
    content: '',
    embeds: [{
      title: `⚙️ Configuring Pipeline: “${d.name}”`,
      description:
        'Establish your automated parameters using the modular controls below. Once all telemetry checks display **🟢**, click **Confirm & Initialize**.\n\n' +
        '💡 *Tip: Enable Discord Developer Mode to copy target channel IDs effortlessly.*',
      color: complete ? COLOR.green : COLOR.blurple,
      fields: [
        { name: `${mark(d.channelId)} Destination Channel`, value: d.channelId ? `<#${d.channelId}>` : '*Pending assignment...*', inline: true },
        { name: `${mark(d.delay)} Frequency Interval`, value: d.delay ? `Every ${fmtDelay(d.delay)}` : '*Pending assignment...*', inline: true },
        { name: `${mark(d.text)} Payload Content`, value: d.text ? quote(d.text) : '*Pending assignment...*' },
      ],
      footer: { text: '🔒 Isolated Simulation Channel · Encrypted User-Token Architecture' },
    }],
    components: [
      row(
        btn(`set:draft:${id}:channelId`, '📍 Channel ID', SECONDARY),
        btn(`set:draft:${id}:text`, '💬 Message Text', SECONDARY),
        btn(`set:draft:${id}:delay`, '⏱️ Frequency', SECONDARY),
        btn(`confirm:${id}`, '🚀 Confirm & Initialize', SUCCESS, !complete),
        btn(`cancel:${id}`, '❌ Abort', DANGER),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

function cardPanel(id, c) {
  const status = c.running
    ? `🟢 **Active Pipeline** ${c.startedAt ? `(Initialized <t:${unix(c.startedAt)}:R>)` : ''}`
    : '🔴 **Paused / Standby**';
  return {
    content: '',
    embeds: [{
      title: `📊 Pipeline: ${c.name}`,
      description: status + (c.lastError ? `\n\n⚠️ **Diagnostic Alert:**\n${c.lastError}` : ''),
      color: c.lastError ? COLOR.red : c.running ? COLOR.green : COLOR.dark,
      fields: [
        { name: '📍 Target', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ Cadence', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 Dispatches', value: `\`${c.sent ?? 0}\` delivered`, inline: true },
        { name: '🕒 Last Dispatch', value: c.lastSentAt ? `<t:${unix(c.lastSentAt)}:R>` : '—', inline: true },
        { name: '💬 Payload', value: quote(c.text) },
      ],
      footer: { text: 'Use control triggers below to manage execution lifecycle.' },
    }],
    components: [
      row(
        btn(`edit:${id}`, '✏️ Modify', PRIMARY),
        btn(`toggle:${id}`, c.running ? '⏹️ Terminate' : '▶️ Execute', c.running ? DANGER : SUCCESS),
        btn(`test:${id}`, '🧪 Test Ping'),
        btn(`refresh:${id}`, '🔄 Sync'),
        btn(`delete:${id}`, '🗑️', DANGER),
      ),
    ],
    allowed_mentions: NO_PINGS,
  };
}

const helpEmbed = () => ({
  color: COLOR.blurple,
  title: '🛡️ Research Security Framework — Command Center',
  description: 'Enterprise-grade automated telemetry dispatcher utilizing user-session credential simulations.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your single account token (Limit: 1 per user).\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and audit automated payload deliveries.',
    },
    {
      name: '⚙️ Core Commands',
      value:
        '`/add-config` · `/list-configs` · `/controller` · `/stop-all` · `/status` · `/add-token`',
    },
  ],
  footer: { text: 'Academic Cybersecurity Case Study Framework v2.5' },
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
      topic: '🔒 Secured Command Center: Monitor, execute, and maintain automated pipelines.',
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

function stopRunner(id) {
  const handle = timers.get(id);
  if (handle) {
    clearInterval(handle);
    timers.delete(id);
  }
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
      currentConfig.lastError = 'Authentication Failure: No valid session token found. Execute `/add-token register` to re-authenticate.';
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
      // Handle rate limits (429) gracefully without killing the runner
      if (err.status === 429) {
        console.warn(`Pipeline ${id}: Rate limited by Discord (429). Backing off this round...`);
        return;
      }
      if (!err.status || err.status >= 500) {
        console.warn(`Pipeline ${id}: transient network delay skipped dispatch (${err.message})`);
        return;
      }
      console.error(`Pipeline ${id} halted:`, err.message);
      stopRunner(id);
      currentConfig.running = false;
      currentConfig.startedAt = null;
      currentConfig.lastError = `Execution Terminated: API endpoint rejected payload dispatch (${err.message}).`;
      save();
      refreshCard(id).catch(() => {});
    }
  };

  if (immediate) tick();
  timers.set(id, setInterval(tick, c.delay * 1000));
}

async function validate(field, raw, guildId, userId) {
  if (field === 'name') {
    return raw ? { value: raw.slice(0, 50) } : { error: 'Configuration name cannot be left blank.' };
  }
  if (field === 'channelId') {
    if (!/^\d{17,20}$/.test(raw)) return { error: 'Invalid Snowflake ID format. Ensure Developer Mode is active.' };
    try {
      const userCreds = store.credentials[userId];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;

      if (!activeToken) {
        return { error: 'Authentication missing: You must register your user token using `/add-token register` before configuring channels.' };
      }

      const ch = await DiscordRequest(`channels/${raw}`, { token: activeToken });
      if (![0, 5].includes(ch.type)) return { error: 'Target destination must be a valid text channel.' };
    } catch (err) {
      return { error: 'Target resolution failed: Channel inaccessible or your user token lacks scope for this channel.' };
    }
    return { value: raw };
  }
  if (field === 'text') {
    return raw ? { value: raw } : { error: 'Payload body cannot be empty.' };
  }
  return { error: 'Unrecognized parameter field.' };
}

function parseDelay(v) {
  const parts = ['hours', 'minutes', 'seconds'].map((k) => (v[k] ?? '').trim());
  if (parts.some((p) => p && !/^\d+$/.test(p)))
    return { error: 'Numerical constraint violation: Use integers only.' };
  const [h, m, s] = parts.map((p) => Number(p || 0));
  const total = h * 3600 + m * 60 + s;
  if (total < MIN_DELAY || total > MAX_DELAY)
    return { error: `Interval out of bounds (${fmtDelay(MIN_DELAY)} to ${fmtDelay(MAX_DELAY)} allowed).` };
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
    if (!guildId) return ephemeral(res, '⚠️ **Context Error**: Command execution restricted to guild servers.');

    if (name === 'add-token') {
      const actionOption = data.options?.find((o) => o.name === 'action')?.value;

      if (actionOption === 'register') {
        // ENFORCE LIMIT: Check if user already registered a token
        const existingTokens = Object.keys(store.credentials[user.id] || {});
        if (existingTokens.length >= 1) {
          return notice(
            res,
            COLOR.amber,
            '⚠️ Token Limit Reached',
            `Your account is restricted to a maximum of **1** registered user token.\n\nCurrently registered profile: \`${existingTokens[0]}\`\n\nUse `/add-token remove` if you wish to purge and replace it.`
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
          value: `Registered: <t:${unix(cred.createdAt)}:R>\nFingerprint: \`${cred.redacted}\``,
        }));
        return reply(res, { embeds: [{ color: COLOR.blurple, title: '🔐 Vault: Registered Credentials (Limit 1/1)', fields }] });
      }

      if (actionOption === 'remove') {
        const userCreds = Object.keys(store.credentials[user.id] || {});
        if (!userCreds.length) return ephemeral(res, '⚠️ Vault is currently empty. No credentials to purge.');
        return reply(res, {
          content: '🗑️ **Security Vault Purge**: Select credential profile to permanently remove:',
          components: [
            row(
              ...userCreds.slice(0, 5).map((label) => btn(`cred:remove:${label}`, `Purge: ${label}`, DANGER))
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
          title: '🟢 System Telemetry & Status',
          fields: [
            { name: '🔒 Credential Vault', value: hasToken ? '✅ Provisioned (1/1)' : '❌ Unregistered', inline: true },
            { name: '📊 Total Pipelines', value: String(mine.length), inline: true },
            { name: '⚡ Active Runners', value: String(mine.filter(([, c]) => c.running).length), inline: true },
            { name: '🕒 System Uptime', value: `<t:${unix(startedAt)}:R>`, inline: true },
          ],
        }],
      });
    }

    if (name === 'list-configs') {
      const mine = mineOf(guildId, user.id);
      if (!mine.length)
        return notice(res, COLOR.blurple, '📭 Zero Pipelines Active', 'Run `/add-config` to provision your first automation channel.');
      const ctrl = store.users[`${guildId}:${user.id}`]?.controllerChannelId;
      return reply(res, {
        embeds: [{
          color: COLOR.blurple,
          title: `📋 Configuration Registry (${mine.length}/${MAX_CONFIGS})`,
          description: ctrl ? `Manage active pipelines in <#${ctrl}>.` : undefined,
          fields: mine.map(([, c]) => ({
            name: `${c.running ? '🟢' : '🔴'} ${clip(c.name, 200)}`,
            value: `Dest: <#${c.channelId}> · Cadence: ${fmtDelay(c.delay)} · Dispatches: \`${c.sent ?? 0}\``,
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
        console.error(err);
        await editOriginal(token, { content: '⚠️ **Initialization Error**: Unable to open controller channel. Verify role permissions.' }).catch(() => {});
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
        content: running.length ? `⏹️ **Emergency Halt**: Successfully terminated ${running.length} active pipeline(s).` : 'ℹ️ No active pipelines were running.',
      }).catch(() => {});
      return;
    }

    if (name === 'add-config') {
      const userTokens = Object.keys(store.credentials[user.id] || {});
      if (!userTokens.length) {
        return notice(
          res,
          COLOR.red,
          '🚫 Authorization Blocked',
          'Security policy requires a registered user credential before provisioning pipelines.\n\n👉 Run `/add-token register` first.'
        );
      }

      const cfgName = data.options[0].value.trim().slice(0, 50);
      if (!cfgName) return ephemeral(res, '⚠️ Configuration name cannot be empty.');

      const saved = mineOf(guildId, user.id).length;
      const open = Object.values(store.drafts).filter((d) => d.userId === user.id && d.guildId === guildId).length;
      if (saved + open >= MAX_CONFIGS)
        return notice(res, COLOR.red, '⚠️ Quota Exceeded', `Maximum limit of **${MAX_CONFIGS}** configurations reached.`);
      if (open >= MAX_OPEN_SETUPS)
        return notice(res, COLOR.red, '⚠️ Unfinished Setups', `Please complete or cancel your ${open} pending setup channels first.`);

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
        const draft = {
          userId: user.id, username: user.username, guildId, name: cfgName,
          channelId: null, text: null, delay: null, createdAt: Date.now(),
        };
        store.drafts[setup.id] = draft;
        save();
        await DiscordRequest(`channels/${setup.id}/messages`, {
          method: 'POST',
          body: { ...setupPanel(setup.id, draft), content: `<@${user.id}> Your pipeline setup environment is ready!`, allowed_mentions: { users: [user.id] } },
        });
        await editOriginal(token, {
          content: '',
          embeds: [{
            color: COLOR.green,
            title: '✅ Setup Environment Provisioned',
            description: `Proceed in <#${setup.id}>.\nCommand Center: <#${controllerId}>`,
          }],
        });
      } catch (err) {
        console.error(err);
        await editOriginal(token, {
          content: '',
          embeds: [{ color: COLOR.red, title: '⚠️ Provisioning Failed', description: 'Verify bot channel creation permissions.' }],
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
          data: { content: `🗑️ **Vault Updated**: Credential profile **${label}** successfully purged. You can now register a new token.`, embeds: [], components: [] },
        });
      }
      return ephemeral(res, '⚠️ Credential profile not found.');
    }

    if (action === 'delete_no') {
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: '✨ Action cancelled safely.', embeds: [], components: [] },
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
          embeds: [{ color: COLOR.dark, title: '❌ Pipeline Aborted', description: 'Cleaning up and destroying setup channel in 5 seconds…' }],
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
      if (!(d.channelId && d.text && d.delay)) return ephemeral(res, '⚠️ Incomplete telemetry: Fill all required parameters.');

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
            title: `🚀 Pipeline “${d.name}” Initialized!`,
            description: `Card registered in <#${controllerId}>. Press **Execute** when ready.\nThis setup channel will self-destruct in 5 seconds…`,
          }],
          components: [],
        });
        setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(console.error), 5000);
      } catch (err) {
        console.error(err);
        delete store.configs[id];
        await editOriginal(token, {
          ...setupPanel(id, d),
          content: '⚠️ Initialization fault encountered. Please retry confirmation.',
        }).catch(() => {});
      }
      return;
    }

    const cfgId = p[0];
    const cfg = store.configs[cfgId];
    if (!cfg || cfg.userId !== user.id) return notYours(res);

    if (action === 'edit') {
      return reply(res, {
        content: `✏️ Select telemetry parameter to modify for **${cfg.name}**:`,
        components: [
          row(
            btn(`set:cfg:${cfgId}:name`, 'Rename', SECONDARY),
            btn(`set:cfg:${cfgId}:channelId`, 'Destination ID', SECONDARY),
            btn(`set:cfg:${cfgId}:text`, 'Payload Text', SECONDARY),
            btn(`set:cfg:${cfgId}:delay`, 'Cadence Timer', SECONDARY),
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
          await editOriginal(token, { content: '⚠️ Authentication missing. Register a token via `/add-token register`.' });
          return;
        }

        await DiscordRequest(`channels/${cfg.channelId}/messages`, {
          method: 'POST',
          token: activeToken,
          body: { content: cfg.text, allowed_mentions: NO_PINGS },
        });
        await editOriginal(token, { content: `🧪 **Test Dispatch Successful**: Payload transmitted to <#${cfg.channelId}>.` });
      } catch (err) {
        console.error(err);
        await editOriginal(token, { content: `⚠️ **Dispatch Rejected**: Target channel lacks permissions or token session expired.` }).catch(() => {});
      }
      return;
    }

    if (action === 'delete') {
      return reply(res, {
        content: `🗑️ **Confirm Deletion**: Permanently destroy **${cfg.name}**?`,
        components: [row(btn(`delete_yes:${cfgId}`, 'Confirm Deletion', DANGER), btn('delete_no', 'Abort'))],
      });
    }

    if (action === 'delete_yes') {
      stopRunner(cfgId);
      delete store.configs[cfgId];
      save();
      res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: `🗑️ Pipeline **${cfg.name}** permanently purged.`, embeds: [], components: [] },
      });
      DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
  }

  if (type === InteractionType.MODAL_SUBMIT) {
    if (data.custom_id === 'modal:add-token:save') {
      // Re-verify limit on submission
      const existingTokens = Object.keys(store.credentials[user.id] || {});
      if (existingTokens.length >= 1) {
        return ephemeral(res, '⚠️ Limit exceeded: You can only register 1 token profile at a time.');
      }

      const values = Object.fromEntries(
        data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']),
      );
      const label = (values.label_name || 'default').trim();
      const rawToken = (values.token_value || '').trim();

      if (!rawToken) return ephemeral(res, '⚠️ Credential payload cannot be blank.');

      const encrypted = encryptCredential(rawToken);
      const redacted = redactToken(rawToken);

      store.credentials[user.id] ??= {};
      store.credentials[user.id][label] = {
        encrypted,
        redacted,
        createdAt: Date.now(),
      };
      save();

      return ephemeral(res, `✅ **Credential Secured (1/1 Limit Reached)**: Profile **${label}** encrypted at rest.\nFingerprint: \`${redacted}\`\n*(You may now provision pipelines using \`/add-config\`)*.`);
    }

    const [, mode, id, field] = data.custom_id.split(':');
    const target = lookup(mode, id);
    if (!target || target.userId !== user.id) return notYours(res);

    const values = Object.fromEntries(
      data.components.flatMap((r) => r.components).map((c) => [c.custom_id, c.value ?? '']),
    );
    const result = field === 'delay'
      ? parseDelay(values)
      : await validate(field, (values.value ?? '').trim(), target.guildId, user.id);
    if (result.error) return ephemeral(res, `⚠️ ${result.error}`);

    target[field] = result.value;
    save();

    if (mode === 'draft') {
      return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: setupPanel(id, target) });
    }

    if (field === 'delay' && target.running) startRunner(id, false);
    if (field === 'channelId') target.lastError = null;
    refreshCard(id).catch(console.error);
    return ephemeral(res, '✅ **Telemetry Updated**: Controller card synchronized.');
  }

  console.error('Unhandled interaction type', type);
  return res.status(400).json({ error: 'unknown interaction' });
}

app.get('/health', (req, res) => res.send('ok'));

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), (req, res) => {
  handle(req, res).catch((err) => {
    console.error('Interaction error:', err);
    if (!res.headersSent) ephemeral(res, '⚠️ System anomaly detected. Please try again.');
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