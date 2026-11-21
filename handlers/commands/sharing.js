// handlers/commands/sharing.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { COLOR, getMaxConfigs } from '../../config/constants.js';
import { row, btn, ephemeral, notice } from '../../ui/primitives.js';
import { DiscordRequest } from '../../utils/discord.js';

export async function handleAllowCopyConfig(req, res, ctx) {
  const { user, guildId, store, saveStore } = ctx;
  store.users ??= {};
  store.users[`${guildId}:${user.id}`] ??= {};

  const currentState = store.users[`${guildId}:${user.id}`].shareable ?? false;
  const newState = !currentState;
  store.users[`${guildId}:${user.id}`].shareable = newState;
  saveStore(store);

  const controllerId = store.users[`${guildId}:${user.id}`].controllerChannelId;

  if (newState && controllerId) {
    await DiscordRequest(`channels/${controllerId}/messages`, {
      method: 'POST',
      body: {
        embeds: [{
          color: COLOR.green,
          title: '🟢 TEMPLATE SHARING ACTIVE',
          description:
            'Your controller templates are now **shareable**. Other operators can mirror your configuration pipelines using `/copy-controller`.\n\nClick the button below instantly to revoke sharing access at any time.',
          timestamp: new Date().toISOString(),
        }],
        components: [row(btn('share:disable', '🛑 Stop Sharing Templates', 4))],
      },
    }).catch(() => {});
  }

  return notice(
    res,
    newState ? COLOR.green : COLOR.amber,
    newState ? '🟢 Template Sharing Enabled' : '🔴 Template Sharing Disabled',
    newState
      ? 'Your configurations are now open for copying. An interactive control prompt has been sent to your Command Center channel.'
      : 'Your template sharing has been deactivated. Other operators can no longer mirror your setup.'
  );
}

export async function handleCopyController(req, res, ctx) {
  const { user, guildId, options, token, store, saveStore, mineOf, ensureController, repostCards, editOriginal, ADMIN_ID } = ctx;
  const sourceUser = options.find((o) => o.name === 'source')?.value;
  const targetUser = options.find((o) => o.name === 'target')?.value || user.id;

  if (!sourceUser) {
    return ephemeral(res, '⚠️ Please provide the `source` operator whose controller you want to copy.');
  }

  if (sourceUser === targetUser) {
    return ephemeral(res, '⚠️ Source and target operator cannot be the same.');
  }

  store.users ??= {};
  const sourceUserData = store.users[`${guildId}:${sourceUser}`];
  const isSourceShareable = sourceUserData?.shareable ?? false;

  if (user.id !== ADMIN_ID && !isSourceShareable) {
    return notice(
      res,
      COLOR.red,
      '🚫 Sharing Restricted',
      `Operator <@${sourceUser}> has not made their controller templates shareable. They must run \`/allow-copy-config\` first to permit mirroring.`
    );
  }

  const sourceConfigs = Object.entries(store.configs || {}).filter(
    ([, c]) => c.userId === sourceUser && c.guildId === guildId
  );

  if (!sourceConfigs.length) {
    return notice(res, COLOR.amber, '📭 Zero Source Pipelines', `Operator <@${sourceUser}> has no active configuration pipelines to copy.`);
  }

  const targetMaxConfigs = getMaxConfigs(targetUser, store);
  const targetExistingCount = mineOf(guildId, targetUser).length;

  if (targetExistingCount + sourceConfigs.length > targetMaxConfigs) {
    const limitStr = targetMaxConfigs === Infinity ? 'Unlimited' : targetMaxConfigs;
    return notice(
      res,
      COLOR.red,
      '⚠️ Quota Exceeded for Target',
      `Cannot copy controller. Target operator <@${targetUser}> has **${targetExistingCount}** existing config(s) and requires **${sourceConfigs.length}** slot(s), exceeding their tier maximum limit of **${limitStr}**.`
    );
  }

  try {
    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });

    const targetUserInfo = await DiscordRequest(`users/${targetUser}`).catch(() => null);
    const targetUsername = targetUserInfo?.username || 'operator';

    let targetControllerId = store.users[`${guildId}:${targetUser}`]?.controllerChannelId;
    if (!targetControllerId) {
      const targetUserObj = { id: targetUser, username: targetUsername };
      targetControllerId = await ensureController(guildId, targetUserObj, store, saveStore);
    }

    let clonedCount = 0;
    for (const [, cfg] of sourceConfigs) {
      const newCfgId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

      store.configs[newCfgId] = {
        userId: targetUser,
        username: targetUsername,
        guildId,
        controllerChannelId: targetControllerId,
        cardMessageId: null,
        name: cfg.name,
        channelId: cfg.channelId,
        text: cfg.text,
        delay: cfg.delay,
        running: false,
        startedAt: null,
        sent: 0,
        failed: 0,
        lastSentAt: null,
        lastError: null,
        createdAt: Date.now(),
      };
      clonedCount++;
    }

    await repostCards(guildId, targetUser, targetControllerId);
    saveStore(store);

    await editOriginal(token, {
      content: '',
      embeds: [{
        color: COLOR.green,
        title: '✅ Controller Cloned Successfully',
        description: `Successfully mirrored **${clonedCount}** configuration pipeline(s) from <@${sourceUser}> to <@${targetUser}>.\n\n📂 **Target Command Center:** <#${targetControllerId}>\n🔒 *Note: All cloned pipelines default to a paused state for safety.*`,
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    console.error('[ERROR] Failed to execute /copy-controller:', err?.message || err);
    await editOriginal(token, {
      content: '',
      embeds: [{ color: COLOR.red, title: '⚠️ Controller Copy Failed', description: `Details: \`${err?.message || 'Unknown error'}\`.` }],
    }).catch(() => {});
  }
}