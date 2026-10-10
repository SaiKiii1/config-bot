import 'dotenv/config';
import { DiscordRequest } from './utils.js';

const COMMANDS = [
  {
    name: 'help',
    description: 'Show how to use this bot',
    type: 1,
    integration_types: [0], // server install only
    contexts: [0], // usable in servers only
  },
  {
    name: 'add-config',
    description: 'Create a new configuration',
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: 'name',
        description: 'Name of the config',
        type: 3, // STRING
        required: true,
        max_length: 50,
      },
    ],
  },
];

await DiscordRequest(`applications/${process.env.APP_ID}/commands`, {
  method: 'PUT',
  body: COMMANDS,
});
console.log('Commands registered:', COMMANDS.map((c) => `/${c.name}`).join(', '));
