// handlers/events.js
import { DiscordRequest } from '../utils.js';

export async function sendWelcomeMessage(userId, channelId) {
  if (!channelId) return;

  const embed = {
    color: 0x5865f2,
    author: {
      name: 'AutomateX STORE',
      icon_url: 'https://media.discordapp.net/attachments/1567118338361139201/1567120185398394990/AutomateX_Orbital_A_Logo.png',
    },
    title: '👋 WELCOME TO AUTOMATEX STORE',
    description: `Hello <@${userId}>, glad you joined! ✨\n\nDiscover premium digital tools, automated pipelines, and highly secure telemetry systems all in one place. Let's get you familiar with our platform before you begin.`,
    fields: [
      {
        name: '📜 START HERE',
        value: 'Read the rules in <#1567187360733601833> to ensure a safe and organized community experience.',
        inline: true,
      },
      {
        name: '💬 NEED HELP?',
        value: 'Open a ticket via <#1567206278579621888>. Explain your needs and our staff will assist you promptly.',
        inline: true,
      },
      {
        name: '🛒 EXPLORE OTHER SERVICES',
        value: '• Top-Ups → <#YOUR_GAME_TOPUP_CHANNEL_ID>\n• Middleman → <#YOUR_MARKETPLACE_CHANNEL_ID>',
        inline: false,
      },
      {
        name: '✅ SHOP SAFELY',
        value: 'Conduct all transactions through official tickets. Beware of DMs claiming to be staff and **never** share your OTP or account tokens.',
        inline: false,
      },
    ],
    footer: {
      text: 'AutomateX STORE • Official Service • Fast, secure, and reliable.',
    },
  };

  try {
    await DiscordRequest(`channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content: `Welcome, <@${userId}>! ✨`,
        embeds: [embed],
      },
    });
  } catch (err) {
    console.error('Failed to send welcome message:', err.message);
  }
}