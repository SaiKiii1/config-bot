// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { bootstrap } from 'global-agent';

// Enable global proxy agent for WebSocket gateway routing
bootstrap();
const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL; // Fixed from URI to URL

if (PROXY_URL) {
  global.GLOBAL_AGENT.HTTP_PROXY = PROXY_URL;
  global.GLOBAL_AGENT.HTTPS_PROXY = PROXY_URL;
}

export function createSelfBotClient() {
  return new Client({
    checkUpdate: false,
    rest: {
      agent: PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined,
    },
  });
}