// register.js
import 'dotenv/config';
import { DiscordRequest } from './utils.js';

const commands = [
  { name: 'help', description: '🛡️ Show Command Center framework documentation.' },
  { name: 'status', description: '🟢 View system telemetry, rollout progress, and security status.' },
  { name: 'diagnose', description: '🩺 Run a health check on your token, controller channel, and failing pipelines.' },
  { name: 'list-configs', description: '📋 Display all active configuration pipelines.' },
  { name: 'delete-all-configs', description: '🗑️ Permanently delete all of your configuration pipelines.' },
  { name: 'controller', description: '📂 Open or restore your secured Command Center channel.' },
  { name: 'stop-all', description: '⏸️ Emergency halt all active dispatch runners.' },
  { name: 'pause-errors', description: '⚠️ Pause only running pipelines that currently have dispatch errors.' },
  {
    name: 'start-staggered',
    description: '🚀 Safely activate all paused configuration pipelines sequentially in waves.',
    options: [
      {
        name: 'delay_seconds',
        description: 'Delay gap in seconds between each config launch (default: 20s)',
        type: 4, // INTEGER
        required: false,
      },
      {
        name: 'order',
        description: 'Launch sequence for your pipelines (defaults to Random)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '🎲 Random (Recommended)', value: 'random' },
          { name: '⬇️ Top to Bottom', value: 'top_to_bottom' },
        ],
      },
    ],
  },
  {
    name: 'cancel-staggered',
    description: '🛑 Abort an in-progress staggered pipeline rollout immediately.',
  },
  {
    name: 'edit-delay-all',
    description: '⏱️ Bulk-update the posting interval across all of your configuration pipelines.',
    options: [
      {
        name: 'seconds',
        description: 'New interval in seconds (5 to 86400)',
        type: 4, // INTEGER
        required: true,
      },
      {
        name: 'scope',
        description: 'Which pipelines to update (defaults to All)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'All Pipelines (Running & Paused)', value: 'all' },
          { name: 'Paused Pipelines Only', value: 'paused' },
        ],
      },
    ],
  },
  {
    name: 'preview-spintax',
    description: '🎲 Dry-run 4 random Spintax variations from a config or custom text without sending.',
    options: [
      {
        name: 'source',
        description: 'Config ID (e.g. rq77h1) or exact Config Name to preview',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'text',
        description: 'Custom Spintax message to test (e.g. {WTS|Selling} item {PM me|DM offers})',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'add-token',
    description: '🔐 Manage encrypted account session credentials.',
    options: [
      {
        type: 3,
        name: 'action',
        description: 'Vault operation',
        required: true,
        choices: [
          { name: 'Register New Token', value: 'register' },
          { name: 'List Registered Tokens', value: 'list' },
          { name: 'Purge Stored Token', value: 'remove' },
        ],
      },
    ],
  },
  {
    name: 'add-config',
    description: '🔄 Provision a new automation pipeline.',
    options: [{ type: 3, name: 'name', description: 'Pipeline reference name', required: true }],
  },
  {
    name: 'duplicate-config',
    description: '📋 Clone an existing pipeline message and interval onto a new channel ID.',
    options: [
      {
        type: 3,
        name: 'source',
        description: 'Config ID (shown on card, e.g. rq77h1) or exact Config Name to duplicate',
        required: true,
      },
      {
        type: 3,
        name: 'channel_id',
        description: 'New destination Channel ID for the cloned pipeline',
        required: true,
      },
      {
        type: 3,
        name: 'name',
        description: 'Optional custom name for the duplicated pipeline (defaults to original name)',
        required: false,
      },
    ],
  },
  {
    name: 'allow-copy-config',
    description: '🔗 Toggle your controller template sharing status on or off for other operators.',
  },
  {
    name: 'copy-controller',
    description: '📋 Mirror another operator\'s shared controller pipelines onto your account.',
    options: [
      { type: 6, name: 'source', description: 'The operator whose templates you want to copy', required: true },
      { type: 6, name: 'target', description: '(Admin) Optional target user to receive the configs', required: false },
    ],
  },
  { name: 'store', description: '💎 (Admin) Publish the official AutomateX pricing and store embed.' },
  {
    name: 'set-trial-duration',
    description: '⏳ (Admin) Set the active free trial duration in days.',
    options: [{ type: 4, name: 'days', description: 'Number of trial days', required: true }],
  },
  {
    name: 'set-price',
    description: '💰 (Admin) Configure the base Lifetime Diamond Lock price.',
    options: [{ type: 4, name: 'lifetime_dl', description: 'Lifetime price in DLs', required: true }],
  },
  {
    name: 'check-access',
    description: '🛡️ (Admin) Verify subscription clearance and expiration status of a user.',
    options: [{ type: 6, name: 'user', description: 'The user to inspect', required: true }],
  },
  { name: 'promotion', description: '🚀 (Admin) Broadcast the official AutomateX launch announcement.' },
  {
    name: 'grant-access',
    description: '🟢 (Admin) Grant subscription access clearance to a user.',
    options: [
      { type: 6, name: 'user', description: 'The operator account to authorize', required: true },
      {
        type: 3,
        name: 'duration',
        description: 'Subscription duration tier',
        required: true,
        choices: [
          { name: '24 Hours', value: '24h' },
          { name: '3 Days', value: '3d' },
          { name: '7 Days', value: '7d' },
          { name: '1 Month', value: '1m' },
          { name: 'Lifetime Pass', value: 'lifetime' },
        ],
      },
    ],
  },
  {
    name: 'extend-access',
    description: '⏳ (Admin) Extend a user\'s existing subscription without wiping their configs or token.',
    options: [
      { type: 6, name: 'user', description: 'The operator account to extend', required: true },
      {
        type: 3,
        name: 'duration',
        description: 'Additional time to add',
        required: true,
        choices: [
          { name: '+24 Hours', value: '24h' },
          { name: '+3 Days', value: '3d' },
          { name: '+1 Week', value: '1w' },
          { name: '+1 Month', value: '1m' },
          { name: 'Upgrade to Permanent', value: 'perm' },
        ],
      },
    ],
  },
  {
    name: 'revoke-access',
    description: '🔴 (Admin) Revoke system access from a user.',
    options: [
      { type: 6, name: 'user', description: 'The operator account to revoke', required: true },
      { type: 3, name: 'reason', description: 'Optional revocation reason', required: false },
    ],
  },
  { name: 'terms-of-service', description: '📜 (Admin) Publish the official AutomateX Terms of Service.' },
];

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await DiscordRequest(`applications/${process.env.APP_ID}/commands`, {
      method: 'PUT',
      body: commands,
    });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();