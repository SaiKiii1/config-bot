// ui/panels.js
import { COLOR } from '../config/constants.js';
import { row, btn, clip, quote, unix, fmtDelay } from './primitives.js';

export function setupPanel(id, d) {
  const hasChannel = Boolean(d.channelId);
  const hasDelay = Boolean(d.delay);
  const hasText = Boolean(d.text);
  const complete = hasChannel && hasDelay && hasText;

  let currentStep = 1;
  if (hasChannel && !hasDelay) currentStep = 2;
  else if (hasChannel && hasDelay && !hasText) currentStep = 3;
  else if (complete) currentStep = 3;

  const stepText = complete ? 'READY' : `STEP ${currentStep} OF 3`;
  const statusBadge = complete ? '🟢 READY' : '🟠 IN PROGRESS';
  const lineCount = d.text ? d.text.split('\n').length : 0;
  const previewText = d.text ? clip(d.text, 300) : '*Pending...*';

  return {
    content: `<@${d.userId}> Your pipeline setup environment is ready!`,
    embeds: [{
      color: complete ? COLOR.green : COLOR.blurple,
      title: '⚙️ AUTOMATEX SETUP WIZARD',
      description: `**Configuring Pipeline:** \`${d.name}\`\n**Status:** ${statusBadge} managed by <@${d.userId}>\n\n**Progress: [ ${stepText} ]**\n1 Channel ${hasChannel ? '✓' : '•'}  ｜  2 Interval ${hasDelay ? '✓' : '•'}  ｜  3 Payload ${hasText ? '✓' : '•'}`,
      fields: [
        { name: '📍 DESTINATION CHANNEL', value: hasChannel ? `<#${d.channelId}>` : '*Pending...*', inline: true },
        { name: '⏱️ FREQUENCY INTERVAL', value: hasDelay ? `Every ${fmtDelay(d.delay)}` : '*Pending...*', inline: true },
        { name: '💬 PAYLOAD CONTENT', value: hasText ? `${lineCount} lines (${d.text.length} chars)\n> ${previewText}` : '*Pending...*' },
      ],
      footer: { text: 'AutomateX Setup Session expires in 10 minutes • Secure Wizard' },
      timestamp: new Date().toISOString(),
    }],
    components: [
      row(
        btn(`set:draft:${id}:channelId`, 'Set Channel', 2),
        btn(`set:draft:${id}:delay`, 'Set Interval', 2),
        btn(`set:draft:${id}:text`, 'Set Message', 2)
      ),
      row(
        btn(`confirm:${id}`, 'Confirm', 3, !complete),
        btn(`cancel:${id}`, 'Abort', 4)
      ),
    ],
  };
}

export function cardPanel(id, c) {
  const isRunning = c.running;
  const hasError = Boolean(c.lastError);
  const statusLabel = hasError ? '⚠️ ATTENTION' : isRunning ? '🟢 RUNNING' : '🔴 PAUSED';
  const color = hasError ? COLOR.red : isRunning ? COLOR.green : COLOR.grey;

  const lineCount = c.text ? c.text.split('\n').length : 0;
  const lastRunText = c.lastSentAt ? `<t:${unix(c.lastSentAt)}:R>` : 'Never';
  const nextRunText = isRunning ? 'Scheduled' : 'Not scheduled';

  return {
    content: '',
    embeds: [{
      title: '⚡ AUTOMATEX PIPELINE CONTROL',
      description: `**Pipeline:** \`${c.name}\`\n**Status:** ${statusLabel} managed by <@${c.userId}>\n\n**Status & Statistics**\nID \`${id.slice(0, 6)}\``,
      color,
      fields: [
        { name: '📍 TARGET', value: `<#${c.channelId}>`, inline: true },
        { name: '⏱️ INTERVAL', value: `Every ${fmtDelay(c.delay)}`, inline: true },
        { name: '📨 SENT', value: `\`${c.sent ?? 0}\``, inline: true },
        { name: '🕒 LAST RUN', value: lastRunText, inline: true },
        { name: '⏳ NEXT RUN', value: nextRunText, inline: true },
        { name: '❌ FAILED', value: `\`${c.failed ?? 0}\``, inline: true },
        ...(hasError ? [{ name: '⚠️ Error Alert', value: `Last dispatch failed: ${c.lastError}` }] : []),
        { name: '💬 Current Payload', value: `${lineCount} lines · ${c.sent ?? 0} posts sent\n${quote(c.text)}` },
      ],
      footer: { text: 'Row 1 runs, pauses or tests. Row 2 edits the message, channel or interval.\nAutomateX Controller • Updated just now' },
      timestamp: new Date().toISOString(),
    }],
    components: [
      row(
        btn(`toggle:${id}`, isRunning ? 'Pause' : 'Execute', isRunning ? 4 : 3),
        btn(`test:${id}`, 'Test', 2),
        btn(`refresh:${id}`, 'Refresh', 2),
        btn(`delete:${id}`, 'Delete', 4)
      ),
      row(
        btn(`edit:${id}`, 'Edit Message', 1),
        btn(`set:cfg:${id}:channelId`, 'Edit Channel', 2),
        btn(`set:cfg:${id}:delay`, 'Edit Interval', 2)
      ),
    ],
  };
}

export const helpEmbed = (trialDays = 7) => ({
  color: COLOR.blurple,
  title: '🛡️ AutomateX — Command Center & Guide',
  description: 'Enterprise-grade Discord automation framework featuring humanized dispatch and secure credential vaulting.',
  fields: [
    {
      name: '📋 Operational Workflow',
      value:
        '1️⃣ **`/add-token register`** — Register your single account token securely.\n' +
        '2️⃣ **`/add-config name`** — Provision an isolated configuration pipeline workspace.\n' +
        '3️⃣ **Controller Panel** — Execute, test, and manage active dispatches.',
    },
    {
      name: '⚙️ Pipeline & Execution Commands',
      value:
        '• **`/add-config`** — Create a new automated posting pipeline.\n' +
        '• **`/duplicate-config`** — Clone an existing pipeline onto a new channel.\n' +
        '• **`/list-configs`** — Display all active and saved pipelines.\n' +
        '• **`/start-staggered`** — Launch paused pipelines sequentially in waves.\n' +
        '• **`/cancel-staggered`** — Abort an in-progress staggered rollout.\n' +
        '• **`/stop-all`** — Emergency halt all running pipelines at once.\n' +
        '• **`/pause-errors`** — Pause only running pipelines with errors.\n' +
        '• **`/edit-delay-all`** — Bulk-update intervals across pipelines.\n' +
        '• **`/delete-all-configs`** — Permanently delete all pipelines and cards.',
    },
    {
      name: '🔐 Vault, Sharing & Telemetry Commands',
      value:
        '• **`/add-token`** — Register, list, or purge your account session token.\n' +
        '• **`/controller`** — Open or restore your private Command Center channel.\n' +
        '• **`/status`** — View system telemetry, rollout progress, and clearance.\n' +
        '• **`/diagnose`** — Run a health check on your token, controller, and errors.\n' +
        '• **`/preview-spintax`** — Dry-run 4 random Spintax variations without sending.\n' +
        '• **`/allow-copy-config`** — Toggle template sharing on or off.\n' +
        '• **`/copy-controller`** — Mirror another operator\'s shared templates.\n' +
        '• **`/help`** — Display this documentation and system guide.',
    },
    {
      name: '🧭 Server Guide & Channels',
      value:
        '• <#1567854828670025748> — Review our legal policies, safety heuristics, and terms of service.\n' +
        '• <#1567187360733601833> — Read community guidelines and core server rules.\n' +
        '• <#1567211746953797743> — Stay updated with official system updates and announcements.\n' +
        '• <#1567212596061540552> — A dedicated space to chat, converse, and hang out with other members.\n' +
        '• <#1567212628386783242> — The recommended channel for executing bot and slash commands.',
    },
  ],
  footer: { text: `AutomateX • Current Trial Duration: ${trialDays} Days` },
  timestamp: new Date().toISOString(),
});

export const adminHelpEmbed = (trialDays = 7) => ({
  color: COLOR.amber,
  title: '🔑 AutomateX — Administrator Command Reference',
  description: 'Restricted management commands available only to the configured system administrator.',
  fields: [
    {
      name: '🛡️ Access & Subscription Management',
      value:
        '• **`/check-access`** — Verify subscription clearance and expiration status of a user.\n' +
        '• **`/grant-access`** — Authorize a user with a specific subscription duration tier.\n' +
        '• **`/extend-access`** — Add extra time to an active user without wiping their setup.\n' +
        '• **`/revoke-access`** — Terminate clearance, purge credentials, and wipe user pipelines.\n' +
        '• **`/copy-controller`** — Use optional `target` parameter to mirror configs onto any user.',
    },
    {
      name: '🏪 Store, Pricing & Broadcast Tools',
      value:
        '• **`/store`** — Publish the official AutomateX license pricing and store showcase embed.\n' +
        '• **`/set-trial-duration`** — Configure the active free trial duration in days.\n' +
        '• **`/set-price`** — Configure the base Lifetime Diamond Lock price (auto-scales tiers).\n' +
        '• **`/promotion`** — Broadcast the official AutomateX launch announcement embed.\n' +
        '• **`/terms-of-service`** — Publish the official legal Terms of Service embed.\n' +
        '• **`/admin-help`** — Display this administrator command reference.',
    },
  ],
  footer: { text: `AutomateX Admin Reference • Active Free Trial: ${trialDays} Days` },
  timestamp: new Date().toISOString(),
});