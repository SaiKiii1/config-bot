// services/controller.js
import { DiscordRequest, privateOverwrites } from '../utils/discord.js';
import { slug } from '../utils/validators.js';
import { cardPanel } from '../ui/panels.js';

const controllerLocks = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureController(guildId, userIdOrUser, store, save) {
  const user = typeof userIdOrUser === 'string' ? { id: userIdOrUser, username: 'user' } : userIdOrUser;
  const key = `${guildId}:${user.id}`;

  if (controllerLocks.has(key)) {
    return controllerLocks.get(key);
  }

  const task = (async () => {
    const existing = store.users[key]?.controllerChannelId;
    if (existing) {
      try {
        await DiscordRequest(`channels/${existing}`);
        return existing;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }

    const configWithController = Object.entries(store.configs || {}).find(
      ([, c]) => c.userId === user.id && c.guildId === guildId && c.controllerChannelId
    );
    if (configWithController) {
      const recoveredId = configWithController[1].controllerChannelId;
      try {
        await DiscordRequest(`channels/${recoveredId}`);
        store.users[key] = { ...(store.users[key] || {}), controllerChannelId: recoveredId };
        save();
        return recoveredId;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }

    const expectedName = `controller-${slug(user.username)}`;
    try {
      const guildChannels = await DiscordRequest(`guilds/${guildId}/channels`);
      const match = guildChannels.find(
        (ch) =>
          ch.type === 0 &&
          ch.parent_id === process.env.CONTROLLER_CATEGORY_ID &&
          ch.name === expectedName &&
          Array.isArray(ch.permission_overwrites) &&
          ch.permission_overwrites.some((ow) => ow.id === user.id)
      );
      if (match) {
        store.users[key] = { ...(store.users[key] || {}), controllerChannelId: match.id };
        save();
        return match.id;
      }
    } catch (e) {
      console.warn('Could not scan guild channels for existing controller:', e.message);
    }

    const ch = await DiscordRequest(`guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: expectedName,
        type: 0,
        parent_id: process.env.CONTROLLER_CATEGORY_ID,
        topic: '🔒 Secured Command Center',
        permission_overwrites: privateOverwrites(guildId, user.id),
      },
    });
    store.users[key] = { ...(store.users[key] || {}), controllerChannelId: ch.id };
    save();
    return ch.id;
  })();

  controllerLocks.set(key, task);
  try {
    return await task;
  } finally {
    controllerLocks.delete(key);
  }
}

export async function repostCards(guildId, userId, controllerId, store, save) {
  let restored = 0;
  const mine = Object.entries(store.configs || {}).filter(
    ([, c]) => c.userId === userId && c.guildId === guildId
  );

  for (const [id, c] of mine) {
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
      if (restored > 0) await sleep(1100);
      c.controllerChannelId = controllerId;
      try {
        const msg = await DiscordRequest(`channels/${controllerId}/messages`, {
          method: 'POST',
          body: cardPanel(id, c),
        });
        c.cardMessageId = msg.id;
        c.cardCreatedAt = Date.now();
        restored++;
      } catch (err) {
        console.error('Failed to restore card UI:', err.message);
      }
    }
  }
  if (restored) save();
  return restored;
}