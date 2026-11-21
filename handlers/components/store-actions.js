// handlers/components/store-actions.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';
import { COLOR } from '../../config/constants.js';
import { row, btn, reply, ephemeral } from '../../ui/primitives.js';
import { DiscordRequest, sendDM, manageRole, privateOverwrites } from '../../utils/discord.js';
import { slug } from '../../utils/validators.js';

export async function handleStoreAction(req, res, ctx) {
  const { data, user, guildId, token, store, saveStore, editOriginal, trialDays } = ctx;
  const customId = data.custom_id;

  if (customId === 'store_free_trial') {
    store.trials ??= {};

    if (store.trials[user.id]) {
      return reply(res, {
        content:
          '⚠️ **Free Trial Already Claimed**: You have already claimed your one-time free trial pass for this account.\n\nIf you would like to continue using the AutomateX auto-post service, please purchase access by opening a ticket in the support channel!',
      });
    }

    if (store.access[user.id]) {
      return reply(res, {
        content: `ℹ️ **Active Access Detected**: You already have active security clearance (\`${store.access[user.id].durationLabel}\`). You do not need a free trial right now!`,
      });
    }

    const now = Date.now();
    const durationMs = trialDays * 24 * 60 * 60 * 1000;
    const expiresAt = now + durationMs;

    store.trials[user.id] = { claimedAt: now };
    store.access[user.id] = { grantedAt: now, expiresAt, durationLabel: `${trialDays} Days (Free Trial)` };
    saveStore(store);

    if (guildId) {
      await manageRole(guildId, user.id, process.env.SUBSCRIBER_ROLE_ID, 'PUT').catch(() => {});
      await manageRole(guildId, user.id, process.env.MEMBER_ROLE_ID, 'DELETE').catch(() => {});
    }

    await sendDM(user.id, {
      embeds: [{
        color: COLOR.green,
        title: `🎉 ${trialDays}-DAY FREE TRIAL ACTIVATED!`,
        description: `Congratulations <@${user.id}>! Your one-time ${trialDays}-day free trial has been successfully claimed.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '⏰ Access Expiration', value: `<t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>)`, inline: false },
          {
            name: '🚀 NEXT STEPS & SETUP GUIDE',
            value:
              '1️⃣ **Register Credential:** Run `/add-token register` to securely vault your account session token.\n2️⃣ **Provision Pipeline:** Run `/add-config name:MyFirstPost` to open your private setup workspace.\n3️⃣ **Command Center:** Control dispatches and view live metrics in your private controller channel.\n\n📌 *Need assistance? Visit <#1567854828670025748> for rules & policies or open a ticket to contact staff.*',
            inline: false,
          },
        ],
        footer: { text: `AutomateX • 1-Time ${trialDays}-Day Free Trial System` },
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});

    return reply(res, {
      content: '✅ **Free Trial Activated!** Check your Direct Messages (DMs) for your confirmation details and expiration status.',
    });
  }

  if (customId === 'store_select_package') {
    if (!guildId) return ephemeral(res, '⚠️ Tickets can only be created inside the server.');

    const selected = data.values?.[0];
    const packages = {
      pkg_3d: { name: '3 Days Pass', pricePHP: '₱30', priceUSD: '~$0.55 USD', priceDLs: '10 Diamond Locks', configs: '10 Config Slots' },
      pkg_7d: { name: '7 Days Pass', pricePHP: '₱60', priceUSD: '~$1.05 USD', priceDLs: '20 Diamond Locks', configs: '25 Config Slots' },
      pkg_1m: { name: '1 Month Pass', pricePHP: '₱150', priceUSD: '~$2.60 USD', priceDLs: '50 Diamond Locks', configs: '50 Config Slots' },
      pkg_lifetime: { name: 'Lifetime Pass', pricePHP: '₱300', priceUSD: '~$5.20 USD', priceDLs: '100 Diamond Locks', configs: 'Unlimited Configs' },
    };

    const pkg = packages[selected];
    if (!pkg) return ephemeral(res, '⚠️ Invalid package selected.');

    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });

    try {
      const ticketName = `ticket-${slug(user.username)}-${selected.replace('pkg_', '')}`;

      const ticketChannel = await DiscordRequest(`guilds/${guildId}/channels`, {
        method: 'POST',
        body: {
          name: ticketName,
          type: 0,
          parent_id: process.env.TICKET_CATEGORY_ID,
          topic: `🎫 Order Ticket for ${user.username} | Package: ${pkg.name}`,
          permission_overwrites: privateOverwrites(guildId, user.id),
        },
      });

      const ADMIN_ID = process.env.ADMIN_ID;
      await DiscordRequest(`channels/${ticketChannel.id}/messages`, {
        method: 'POST',
        body: {
          content: `<@${user.id}> ${ADMIN_ID ? `<@${ADMIN_ID}>` : ''}`,
          embeds: [{
            color: COLOR.blurple,
            title: `🎫 ORDER TICKET — ${pkg.name.toUpperCase()}`,
            description: `Hello <@${user.id}>! Thank you for choosing AutomateX.\n\nYou have selected to purchase **${pkg.name}**.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            fields: [
              { name: '📦 Selected Package', value: `\`${pkg.name}\``, inline: true },
              { name: '⚙️ Pipeline Capacity', value: `\`${pkg.configs}\``, inline: true },
              { name: '💰 Price Options', value: `• **Local Currency:** ${pkg.pricePHP}\n**USD International:** ${pkg.priceUSD}\n**Growtopia:** ${pkg.priceDLs}`, inline: false },
              { name: '📜 IMPORTANT NOTICE', value: 'Before you continue purchasing, please make sure you have thoroughly read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>).', inline: false },
              { name: '💳 SELECT PAYMENT METHOD BELOW', value: 'Click a button below to view specific payment account details & instructions!', inline: false },
            ],
            footer: { text: 'AutomateX Checkout Ticket • Select payment method to proceed' },
            timestamp: new Date().toISOString(),
          }],
          components: [
            row(
              btn(`pay_method:gcash:${selected}`, '🇵🇭 GCash', 3),
              btn(`pay_method:paypal:${selected}`, '🅿️ PayPal', 1),
              btn(`pay_method:wise:${selected}`, '💸 Wise', 1),
              btn(`pay_method:dls:${selected}`, '💎 Diamond Locks', 2)
            ),
            row(btn(`close_ticket:${ticketChannel.id}`, '🔒 Close Ticket', 4)),
          ],
        },
      });

      await editOriginal(token, { content: `✅ **Ticket Created!** Proceed to <#${ticketChannel.id}> to complete your order.` });
    } catch (err) {
      console.error('[ERROR] Failed to create order ticket:', err);
      await editOriginal(token, { content: `⚠️ **Ticket Creation Failed**: ${err.message}` }).catch(() => {});
    }
    return true;
  }

  if (customId?.startsWith('pay_method:')) {
    const [, method] = customId.split(':');

    if (method === 'gcash') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.green,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '🇵🇭 **GCash QR Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Scan the QR code below** using your GCash app to complete payment.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Please send a screenshot of the completed transaction receipt here in this channel once paid!*',
            image: { url: 'https://i.imgur.com/JHVxpgp.png' },
            footer: { text: 'AutomateX Checkout • Instant Staff Verification' },
          }],
        },
      });
    }

    if (method === 'paypal') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.green,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '🅿️ **PayPal International QR Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Scan the QR code below** using your PayPal app to complete payment.\n**Transfer Mode:** Friends & Family (F&F)\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Please send a screenshot of the payment confirmation here in this channel once sent!*',
            image: { url: 'https://i.imgur.com/XjZL7id.png' },
            footer: { text: 'AutomateX Checkout • Instant Staff Verification' },
          }],
        },
      });
    }

    if (method === 'wise') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.blurple,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '💸 **Wise International Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Please wait for assistance from our admins.**\nAn administrator will respond in this ticket shortly to provide Wise payment details and assist you with your transfer.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Thank you for your patience!*',
            footer: { text: 'AutomateX Checkout • Admin Assistance Required' },
          }],
        },
      });
    }

    if (method === 'dls') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            color: COLOR.blurple,
            title: '💳 PAYMENT DETAILS & CHECKOUT INSTRUCTIONS',
            description: '💎 **Growtopia Diamond Locks (DLs) Payment**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Please wait for assistance from our admins.**\nAn administrator will join this ticket shortly to provide the World Name, trade details, or meet you in-game.\n\n📜 **Reminder:** Please ensure you have read our server rules (<#1567187360733601833>) and terms of service (<#1567854828670025748>) before proceeding.\n\n📌 *Thank you for your patience!*',
            footer: { text: 'AutomateX Checkout • Admin Assistance Required' },
          }],
        },
      });
    }
  }

  if (customId?.startsWith('close_ticket:')) {
    const channelId = customId.split(':')[1];
    res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '🔒 **Closing Ticket**: Purging channel in 5 seconds...' },
    });
    setTimeout(() => {
      DiscordRequest(`channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
    }, 5000);
    return true;
  }

  if (customId === 'store_guide') {
    return reply(res, {
      embeds: [{
        color: COLOR.blurple,
        title: '📖 Complete Step-by-Step Guide — AutomateX',
        fields: [
          { name: '📌 STEP 1: Register Token', value: 'Run `/add-token register` in your server and input your encrypted account session token.' },
          { name: '📌 STEP 2: Provision Pipeline', value: 'Run `/add-config name:MY_PIPELINE` to generate a setup workspace.' },
          { name: '📌 STEP 3: Configure Parameters', value: 'Set destination channel ID, dispatch text message, and execution interval.' },
          { name: '📌 STEP 4: Launch Controller', value: 'Execute the pipeline from your private Command Center channel!' },
        ],
      }],
    });
  }

  if (customId === 'store_features') {
    return reply(res, {
      embeds: [{
        color: COLOR.green,
        title: '⚡ AutomateX — Core Features & Advantages',
        fields: [
          { name: '1. Serverless & Cloud Hosted 24/7', value: 'Runs on high-availability cloud infrastructure without requiring your PC to stay on.' },
          { name: '2. Hardware Encryption (AES-256-GCM)', value: 'Your Discord account tokens are encrypted at rest with isolated keys.' },
          { name: '3. Humanized Anti-Ban Telemetry', value: 'Features typing indicators, read acknowledgments, and organic jitter algorithms.' },
          { name: '4. Dedicated Sticky Residential Proxy Pools', value: 'Isolated connection tunnels per user to preserve account safety.' },
        ],
      }],
    });
  }

  return false;
}