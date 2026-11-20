// register.js
import 'dotenv/config';
import { DiscordRequest } from './utils.js';

const commands = [
  { name: 'help', description: '🛡️ Show Command Center framework documentation.' },
  { name: 'status', description: '🟢 View system telemetry, rollout progress, and security status.' },
  { name: 'list-configs', description: '📋 Display all active configuration pipelines.' },
  { name: 'delete-all-configs', description: '🗑️ Permanently delete all of your configuration pipelines.' },
  { name: 'controller', description: '📂 Open or restore your secured Command Center channel.' },
  { name: 'stop-all', description: '⏹️ Emergency halt all active dispatch runners.' },
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
      }
    ]
  },
  {
    name: 'cancel-staggered',
    description: '🛑 Abort an in-progress staggered pipeline rollout immediately.',
  },
  {
    name: 'add-token',
    description: '🔐 Manage your security vault credential.',
    options: [
      {
        type: 3, name: 'action', description: 'Action to perform', required: true,
        choices: [
          { name: 'Register Token', value: 'register' },
          { name: 'List Credentials', value: 'list' },
          { name: 'Purge Vault', value: 'remove' }
        ]
      }
    ]
  },
  {
    name: 'add-config',
    description: '🔧 Provision a new automation pipeline.',
    options: [{ type: 3, name: 'name', description: 'Pipeline reference name', required: true }]
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
      }
    ]
  },
  {
    name: 'allow-copy-config',
    description: '🔓 Toggle your controller template sharing status on or off for other operators.'
  },
  {
    name: 'copy-controller',
    description: '📋 Mirror another operator\'s shared controller and configuration pipelines.',
    options: [
      {
        name: 'source',
        description: 'The operator whose controller/configs you want to copy',
        type: 6, // USER type
        required: true,
      },
      {
        name: 'target',
        description: 'The operator who will receive the mirrored configuration pipelines (Optional: defaults to you)',
        type: 6, // USER type
        required: false,
      }
    ]
  },
  {
    name: 'set-trial-duration',
    description: '🛠️ (Admin) Set the duration of the free trial in days.',
    options: [
      { type: 4, name: 'days', description: 'Number of days for the free trial', required: true }
    ]
  },
  {
    name: 'set-price',
    description: '💎 (Admin) Set the base Lifetime Diamond Lock price (shorter tiers auto-scale proportionally).',
    options: [
      { type: 4, name: 'lifetime_dl', description: 'The new price in Diamond Locks (DLs) for Lifetime access', required: true }
    ]
  },
  {
    name: 'check-access',
    description: '🔍 (Admin) Check subscription clearance, duration, and expiration status of a user.',
    options: [
      { type: 6, name: 'target', description: 'The user to check access for', required: true }
    ]
  },
  {
    name: 'grant-access',
    description: '🔑 (Admin) Grant a user access to the automation framework.',
    options: [
      { type: 6, name: 'user', description: 'The operator account to authorize', required: true },
      { type: 3, name: 'duration', description: 'The validity period for this clearance', required: true,
        choices: [
          { name: '24 Hours', value: '24h' },
          { name: '3 Days', value: '3d' },
          { name: '1 Week', value: '1w' },
          { name: '1 Month', value: '1m' },
          { name: 'Permanent', value: 'perm' }
        ]
      }
    ]
  },
  {
    name: 'revoke-access',
    description: '🚫 (Admin) Revoke system access from a user.',
    options: [
      { type: 6, name: 'user', description: 'The operator account to terminate clearance for', required: true },
      { type: 3, name: 'reason', description: 'Reason for revocation (sent to user)', required: false }
    ]
  },
  {
    name: 'promotion',
    description: '📢 (Admin) Post the official AutomateX promotional message in this channel.'
  },
  {
    name: 'terms-of-service',
    description: '⚖️ (Admin) Publish the official AutomateX Terms of Service embed.'
  },
  {
    name: 'store',
    description: '📢 (Admin) Publish the official AutomateX Store & Pricing showcase embed.'
  }
];

try {
  console.log('Started refreshing application (/) commands.');
  await DiscordRequest(`applications/${process.env.APP_ID}/commands`, { method: 'PUT', body: commands });
  console.log('Successfully reloaded application (/) commands.');
} catch (error) {
  console.error(error);
}