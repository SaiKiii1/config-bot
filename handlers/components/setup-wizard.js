// handlers/components/setup-wizard.js
import { InteractionResponseType } from 'discord-interactions';
import { COLOR } from '../../config/constants.js';
import { ephemeral, notYours } from '../../ui/primitives.js';
import { cardPanel } from '../../ui/panels.js';
import { DiscordRequest } from '../../utils/discord.js';

export async function handleSetupWizardAction(req, res, action, p, ctx) {
  const { user, token, store, saveStore, lookup, modal, setupPanel, editOriginal } = ctx;

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
      data: {
        content: '',
        embeds: [{ color: COLOR.dark, title: '❌ Pipeline Aborted', description: 'Destroying setup channel in 5 seconds…' }],
        components: [],
      },
    });
    setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(() => {}), 5000);
    return true;
  }

  if (action === 'confirm') {
    const [id] = p;
    const d = store.drafts[id];
    if (!d || d.userId !== user.id) return notYours(res);
    if (!(d.channelId && d.text && d.delay)) {
      return ephemeral(res, '⚠️ Incomplete telemetry: Fill all required parameters.');
    }

    res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    try {
      const controllerId = store.users[`${d.guildId}:${d.userId}`]?.controllerChannelId;
      const cfg = {
        userId: d.userId,
        guildId: d.guildId,
        name: d.name,
        channelId: d.channelId,
        text: d.text,
        delay: d.delay,
        running: false,
        lastError: null,
        sent: 0,
        lastSentAt: null,
        startedAt: null,
        controllerChannelId: controllerId,
        cardMessageId: null,
      };
      store.configs[id] = cfg;
      const msg = await DiscordRequest(`channels/${controllerId}/messages`, {
        method: 'POST',
        body: cardPanel(id, cfg),
      });
      cfg.cardMessageId = msg.id;
      delete store.drafts[id];
      saveStore(store);

      await editOriginal(token, {
        content: '',
        embeds: [{
          color: COLOR.green,
          title: `🚀 Task “${d.name}” Initialized!`,
          description: `Card registered in <#${controllerId}>.`,
        }],
        components: [],
      });
      setTimeout(() => DiscordRequest(`channels/${id}`, { method: 'DELETE' }).catch(() => {}), 5000);
    } catch {
      delete store.configs[id];
      await editOriginal(token, { ...setupPanel(id, d), content: '⚠️ Initialization fault encountered.' }).catch(() => {});
    }
    return true;
  }

  return false;
}