// handlers/components/index.js
import { InteractionResponseType } from 'discord-interactions';
import { COLOR } from '../../config/constants.js';
import { ephemeral } from '../../ui/primitives.js';
import { handleStoreAction } from './store-actions.js';
import { handleSetupWizardAction } from './setup-wizard.js';
import { handleConfirmDeleteAll, handlePipelineAction } from './pipeline-actions.js';

export { handleModalSubmit } from './modals.js';

const SETUP_ACTIONS = new Set(['set', 'cancel', 'confirm']);
const PIPELINE_ACTIONS = new Set(['edit', 'toggle', 'refresh', 'test', 'delete', 'delete_yes']);

export async function handleComponent(
  req,
  res,
  store,
  saveStore,
  lookup,
  modal,
  setupPanel,
  cardPanelArg,
  validate,
  parseDelay,
  refreshCard,
  editOriginal
) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;

  store.settings ??= {};
  store.settings.trialDurationDays ??= 7;
  const trialDays = store.settings.trialDurationDays;

  const ctx = {
    data,
    user,
    guildId,
    token,
    store,
    saveStore,
    lookup,
    modal,
    setupPanel,
    refreshCard,
    editOriginal,
    trialDays,
  };

  if (data.custom_id === 'share:disable') {
    store.users ??= {};
    store.users[`${guildId}:${user.id}`] ??= {};
    store.users[`${guildId}:${user.id}`].shareable = false;
    saveStore(store);

    return res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [{
          color: COLOR.red,
          title: '🔴 TEMPLATE SHARING DISABLED',
          description: 'Template sharing has been successfully **revoked**. Other operators can no longer mirror your controller pipelines.',
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    });
  }

  const handledStore = await handleStoreAction(req, res, ctx);
  if (handledStore !== false) return;

  const [action, ...p] = data.custom_id.split(':');

  if (action === 'confirm_delete_all') {
    return handleConfirmDeleteAll(req, res, ctx);
  }

  const ADMIN_ID = process.env.ADMIN_ID;
  const access = store.access[user.id];
  const now = Date.now();

  if (user.id !== ADMIN_ID) {
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      return ephemeral(
        res,
        '🚫 Clearance Required: Your security clearance has expired or been revoked. You cannot interact with these controls.'
      );
    }
  }

  if (action === 'cred' && p[0] === 'remove') {
    const label = p[1];
    if (store.credentials[user.id]?.[label]) {
      delete store.credentials[user.id][label];
      saveStore(store);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `🗑️ **Vault Updated**: Credential profile **${label}** successfully purged.`,
          embeds: [],
          components: [],
        },
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

  if (SETUP_ACTIONS.has(action)) {
    return handleSetupWizardAction(req, res, action, p, ctx);
  }

  if (PIPELINE_ACTIONS.has(action)) {
    return handlePipelineAction(req, res, action, p, ctx);
  }
}