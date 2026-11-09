// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';

const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;

export function createSelfBotClient() {
  return new Client({
    checkUpdate: false,
    rest: {
      agent: PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined,
    },
    // Ensure WebSocket gateway also uses the proxy agent cleanly
    ws: {
      agent: PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined,
    }
  });
}