// handlers/commands.js (or commands.js)
const base = { type: 1, integration_types: [0], contexts: [0] }; // server-only slash commands

export const COMMANDS = [
  { ...base, name: 'help', description: 'How to use this bot' },
  {
    ...base,
    name: 'add-config',
    description: 'Create a new auto-post configuration',
    options: [{ name: 'name', description: 'A name for this config', type: 3, required: true, max_length: 50 }],
  },
  { ...base, name: 'list-configs', description: 'See all of your configs and their status' },
  { ...base, name: 'controller', description: 'Open (or repair) your private controller channel' },
  { ...base, name: 'stop-all', description: 'Stop all of your running configs at once' },
  { ...base, name: 'status', description: 'Check that the bot is online' },
  {
    ...base,
    name: 'terms-of-service',
    description: '(Admin) Publish the official AutomateX Terms of Service embed.',
  },
  {
    ...base,
    name: 'add-token',
    description: 'Securely register and manage research credentials for comparison study',
    options: [
      {
        name: 'action',
        description: 'Credential management action',
        type: 3,
        required: true,
        choices: [
          { name: 'Register / Update Credential', value: 'register' },
          { name: 'List Stored Credentials (Redacted)', value: 'list' },
          { name: 'Remove Stored Credential', value: 'remove' },
        ],
      },
    ],
  },
];