// client-manager.js
import { Client } from 'discord.js-selfbot-v13';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL;

export function createSelfBotClient() {
  return new Client({
    checkUpdate: false,
    rest: {
      agent: PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined,
    },
    // FIX: WebSockets must use standard node agent, not Undici
    ws: {
      agent: PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined,
    }
  });
}