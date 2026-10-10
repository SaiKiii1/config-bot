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
];