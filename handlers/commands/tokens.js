// handlers/commands/tokens.js
import { COLOR } from '../../config/constants.js';
import { row, btn, reply, ephemeral, notice } from '../../ui/primitives.js';
import { credentialInputModal } from '../../ui/modals.js';

export function handleAddToken(req, res, ctx) {
  const { user, options, store } = ctx;
  const actionOption = options.find((o) => o.name === 'action')?.value;

  if (actionOption === 'register') {
    const existingTokens = Object.keys(store.credentials[user.id] || {});
    if (existingTokens.length >= 1) {
      return notice(
        res,
        COLOR.amber,
        '⚠️ Token Limit Reached',
        `Your account is restricted to a maximum of **1** registered user token.\n\nCurrently registered profile: \`${existingTokens[0]}\`\n\nUse \`/add-token remove\` if you wish to purge and replace it.`
      );
    }
    return res.send(credentialInputModal());
  }

  if (actionOption === 'list') {
    const userCreds = Object.entries(store.credentials[user.id] || {});
    if (!userCreds.length) {
      return notice(
        res,
        COLOR.amber,
        '⚠️ No Credentials Found',
        'Your security profile has no registered tokens.\n\nExecute `/add-token register` to begin.'
      );
    }
    const fields = userCreds.map(([label, cred]) => ({
      name: `🏷️ Profile: ${label}`,
      value: `Registered: <t:${Math.floor(cred.createdAt / 1000)}:R>\nFingerprint: \`${cred.redacted}\``,
    }));
    return reply(res, {
      embeds: [{ color: COLOR.blurple, title: '🔐 Vault: Registered Credentials (Limit 1/1)', fields }],
    });
  }

  if (actionOption === 'remove') {
    const userCreds = Object.keys(store.credentials[user.id] || {});
    if (!userCreds.length) return ephemeral(res, '⚠️ Vault is currently empty. No credentials to purge.');
    return reply(res, {
      content: '🗑️ **Security Vault Purge**: Select credential profile to permanently remove:',
      components: [row(...userCreds.slice(0, 5).map((label) => btn(`cred:remove:${label}`, `Purge: ${label}`, 4)))],
    });
  }
}