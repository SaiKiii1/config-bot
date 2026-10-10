import 'dotenv/config';
import { DiscordRequest } from './utils.js';
import { COMMANDS } from './commands.js';

await DiscordRequest(`applications/${process.env.APP_ID}/commands`, {
  method: 'PUT',
  body: COMMANDS,
});
console.log('Commands registered:', COMMANDS.map((c) => `/${c.name}`).join(', '));