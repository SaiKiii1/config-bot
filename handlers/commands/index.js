// handlers/commands/index.js
import { COLOR } from '../../config/constants.js';
import { ephemeral, notice } from '../../ui/primitives.js';
import { handleHelp, handleDiagnose, handleStatus, handleController } from './diagnostics.js';
import {
  handleListConfigs,
  handleDeleteAllConfigs,
  handleStopAll,
  handlePauseErrors,
  handleEditDelayAll,
  handlePreviewSpintax,
  handleStartStaggered,
  handleCancelStaggered,
  handleAddConfig,
  handleDuplicateConfig,
} from './pipelines.js';
import { handleAddToken } from './tokens.js';
import { handleAllowCopyConfig, handleCopyController } from './sharing.js';
import {
  handleSetTrialDuration,
  handleSetPrice,
  handleStore,
  handleCheckAccess,
  handlePromotion,
  handleGrantAccess,
  handleExtendAccess,
  handleRevokeAccess,
} from './admin.js';

const PUBLIC_OR_ADMIN_COMMANDS = new Set([
  'grant-access',
  'extend-access',
  'revoke-access',
  'promotion',
  'store',
  'set-trial-duration',
  'set-price',
  'copy-controller',
  'allow-copy-config',
]);

const COMMAND_HANDLERS = {
  diagnose: handleDiagnose,
  status: handleStatus,
  controller: handleController,
  'list-configs': handleListConfigs,
  'delete-all-configs': handleDeleteAllConfigs,
  'stop-all': handleStopAll,
  'pause-errors': handlePauseErrors,
  'edit-delay-all': handleEditDelayAll,
  'preview-spintax': handlePreviewSpintax,
  'start-staggered': handleStartStaggered,
  'cancel-staggered': handleCancelStaggered,
  'add-config': handleAddConfig,
  'duplicate-config': handleDuplicateConfig,
  'add-token': handleAddToken,
  'allow-copy-config': handleAllowCopyConfig,
  'copy-controller': handleCopyController,
  'set-trial-duration': handleSetTrialDuration,
  'set-price': handleSetPrice,
  store: handleStore,
  'check-access': handleCheckAccess,
  promotion: handlePromotion,
  'grant-access': handleGrantAccess,
  'extend-access': handleExtendAccess,
  'revoke-access': handleRevokeAccess,
};

export async function handleCommand(
  req,
  res,
  store,
  saveStore,
  mineOf,
  ensureController,
  repostCards,
  editOriginal,
  setupPanel,
  btn,
  row,
  refreshCard
) {
  const { data, token } = req.body;
  const user = req.body.member?.user ?? req.body.user;
  const guildId = req.body.guild_id;
  const { name } = data;
  const options = data.options ?? [];
  const ADMIN_ID = process.env.ADMIN_ID;

  store.settings ??= {};
  store.settings.trialDurationDays ??= 7;
  store.settings.lifetimePrice ??= 100;
  const trialDays = store.settings.trialDurationDays;
  const lifetimePrice = store.settings.lifetimePrice;

  const prices = {
    dLife: lifetimePrice,
    d1m: Math.max(1, Math.round(lifetimePrice * 0.5)),
    d7: Math.max(1, Math.round(lifetimePrice * 0.2)),
    d3: Math.max(1, Math.round(lifetimePrice * 0.1)),
  };

  const ctx = {
    user,
    guildId,
    options,
    token,
    store,
    saveStore,
    mineOf,
    ensureController,
    repostCards,
    editOriginal,
    setupPanel,
    btn,
    row,
    refreshCard,
    ADMIN_ID,
    trialDays,
    prices,
  };

  if (name === 'help') return handleHelp(res, ctx);
  if (!guildId) return ephemeral(res, '⚠️ **Context Error**: Command execution restricted to guild servers.');

  if (!PUBLIC_OR_ADMIN_COMMANDS.has(name) && user.id !== ADMIN_ID) {
    const access = store.access[user.id];
    const now = Date.now();
    if (!access || (access.expiresAt !== 'permanent' && now > access.expiresAt)) {
      if (access) {
        delete store.access[user.id];
        saveStore(store);
      }
      return notice(
        res,
        COLOR.red,
        '🚫 Clearance Required',
        'You do not have active security clearance to operate this framework. Please contact the administrator.'
      );
    }
  }

  const handler = COMMAND_HANDLERS[name];
  if (handler) {
    return handler(req, res, ctx);
  }
}