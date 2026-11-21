// handlers/components/pipeline-actions.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { row, btn, reply, notYours } from '../../ui/primitives.js';
import { cardPanel } from '../../ui/panels.js';
import { DiscordRequest } from '../../utils/discord.js';
import { decryptCredential } from '../../utils/crypto.js';
import { startRunner, stopRunner } from '../../services/runner.js';
import { getUserClient } from '../../client-manager.js';

export async function handleConfirmDeleteAll(req, res, ctx) {
  const { user, guildId, token, store, saveStore } = ctx;
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
      components: [],
    },
  });
}

export async function handlePipelineAction(req, res, action, p, ctx) {
  const { user, token, store, saveStore, refreshCard, editOriginal } = ctx;
  const cfgId = p[0];
  const cfg = store.configs[cfgId];
  if (!cfg || cfg.userId !== user.id) return notYours(res);

  if (action === 'edit') {
    const panel = cardPanel(cfgId, cfg);
    panel.components = [
      row(
        btn(`set:cfg:${cfgId}:name`, 'Rename', 2),
        btn(`set:cfg:${cfgId}:channelId`, 'Target ID', 2),
        btn(`set:cfg:${cfgId}:text`, 'Message Text', 2),
        btn(`set:cfg:${cfgId}:delay`, 'Timer', 2),
        btn(`refresh:${cfgId}`, '🔙 Cancel', 4)
      ),
    ];
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: panel });
  }

  if (action === 'toggle') {
    cfg.running = !cfg.running;
    cfg.lastError = null;
    cfg.startedAt = cfg.running ? Date.now() : null;
    saveStore(store);
    res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
    if (cfg.running) startRunner(cfgId, true, store, saveStore, refreshCard);
    else stopRunner(cfgId, store);
    return true;
  }

  if (action === 'refresh') {
    return res.send({ type: InteractionResponseType.UPDATE_MESSAGE, data: cardPanel(cfgId, cfg) });
  }

  if (action === 'test') {
    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });
    try {
      const userCreds = store.credentials[user.id];
      const firstKey = userCreds ? Object.keys(userCreds)[0] : null;
      const activeToken = firstKey ? decryptCredential(userCreds[firstKey].encrypted) : null;
      if (!activeToken) {
        await editOriginal(token, { content: '⚠️ Authentication missing. Register a token via `/add-token register`.' });
        return true;
      }

      const client = await getUserClient(user.id, activeToken);
      const channel = await client.channels.fetch(cfg.channelId);
      await channel.send({ content: cfg.text, allowed_mentions: { parse: [] } });

      await editOriginal(token, { content: `🧪 **Test Dispatch Successful**: Message transmitted to <#${cfg.channelId}>.` });
    } catch (err) {
      console.error('TEST ERROR:', err);
      await editOriginal(token, { content: `⚠️ **Dispatch Rejected**: ${err.message}` }).catch(() => {});
    }
    return true;
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
    res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: `🗑️ Task **${cfg.name}** permanently purged.`, embeds: [], components: [] },
    });
    DiscordRequest(`channels/${cfg.controllerChannelId}/messages/${cfg.cardMessageId}`, { method: 'DELETE' }).catch(() => {});
    return true;
  }

  return false;
}