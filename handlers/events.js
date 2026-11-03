// handlers/events.js
import { DiscordRequest } from '../utils.js';

export async function sendWelcomeMessage(userId, channelId) {
  if (!channelId) return;

  const embed = {
    color: 0x5865f2,
    author: {
      name: 'AutomateX STORE',
      icon_url: 'https://media.discordapp.net/attachments/1567118338361139201/1567120185398394990/AutomateX_Orbital_A_Logo.png?ex=6aeb05e7&is=6ae9b467&hm=e27110061c7f6bdb58d5a287943f12078bcf8dc5d275c766ad3a73a1283d00a4&=&format=webp&quality=lossless&width=512&height=512' // Replace with your bot's icon URL
    },
    title: '👋 WELCOME TO AUTOMATEX STORE',
    description: `Hello <@${userId}>, glad you joined! 🌟\n\nDiscover premium digital tools, automated pipelines, and highly secure telemetry systems all in one place. Let's get you familiar with our platform before you begin.`,
    fields: [
      {
        name: '📜 START HERE',
        value: 'Read the rules in <#YOUR_RULES_CHANNEL_ID> to ensure a safe and organized community experience.',
        inline: true
      },
      {
        name: '💎 FIND YOUR PRODUCT',
        value: 'Visit <#YOUR_PREMIUM_APP_CHANNEL_ID> to browse our selection of applications, subscription plans, and pricing.',
        inline: true
      },
      {
        name: '💬 NEED HELP?',
        value: 'Open a ticket via <#YOUR_TICKET_CHANNEL_ID>. Explain your needs and our staff will assist you promptly.',
        inline: true
      },
      {
        name: '🛒 EXPLORE OTHER SERVICES',
        value: '• Top-Ups ➔ <#YOUR_GAME_TOPUP_CHANNEL_ID>\n• Middleman ➔ <#YOUR_MARKETPLACE_CHANNEL_ID>',
        inline: false
      },
      {
        name: '✅ SHOP SAFELY',
        value: 'Conduct all transactions through official tickets. Beware of DMs claiming to be staff and **never** share your OTP or account tokens.',
        inline: false
      }
    ],
    footer: {
      text: 'AutomateX STORE • Official Service • Fast, secure, and reliable.'
    }
  };

  try {
    await DiscordRequest(`channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content: `Welcome, <@${userId}>! ✨`,
        embeds: [embed]
      }
    });
  } catch (err) {
    console.error('Failed to send welcome message:', err.message);
  }
}