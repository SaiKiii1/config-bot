// handlers/components/modals.js
import { InteractionResponseType } from 'discord-interactions';
import { ephemeral, notYours } from '../../ui/primitives.js';
import { encryptCredential, redactToken } from '../../utils/crypto.js';
import { startRunner } from '../../services/runner.js';

export async function handleModalSubmit(req, res, store, saveStore, lookup, validate, parseDelay, refreshCard, setupPanel) {
  const { data } = req.body;
  const user = req.body.member?.user ?? req.body.user;

  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(res, '🚫 Clearance Required: Your security clearance has expired or been revoked.');
    }
  }

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
  const result =
    field === 'delay'
      ? parseDelay(values)
      : await validate(field, (values.value ?? '').trim(), target.guildId, user.id, store);
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