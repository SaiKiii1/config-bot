// register.js
import 'dotenv/config';
import { DiscordRequest } from './utils.js';

const commands = [
  { name: 'help', description: '🛡️ Show Command Center framework documentation.' },
  { name: 'status', description: '🟢 View system telemetry and security status.' },
  { name: 'list-configs', description: '📋 Display all active configuration pipelines.' },
  { name: 'controller', description: '📂 Open or restore your secured Command Center channel.' },
  { name: 'stop-all', description: '⏹️ Emergency halt all active dispatch runners.' },
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