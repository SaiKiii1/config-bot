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
      name: '⚙️ Core User Commands',
      value:
        '• **`/help`** — Display this documentation and system guide.\n' +
        '• **`/status`** — View your system telemetry, credential status, and clearance.\n' +
        '• **`/diagnose`** — Run a diagnostic health check on your token, controller, and failing pipelines.\n' +
        '• **`/list-configs`** — See all of your active and saved configuration pipelines.\n' +
        '• **`/delete-all-configs`** — Permanently purge all of your configuration pipelines and controller cards.\n' +
        '• **`/controller`** — Open or restore your private secured Command Center channel.\n' +
        '• **`/stop-all`** — Emergency halt all of your running configuration pipelines at once.\n' +
        '• **`/pause-errors`** — Pause only running pipelines that currently have errors.\n' +
        '• **`/start-staggered`** — Safely launch all paused configuration pipelines sequentially with a custom delay gap.\n' +
        '• **`/cancel-staggered`** — Abort an in-progress staggered pipeline rollout immediately.\n' +
        '• **`/edit-delay-all`** — Bulk-update the interval across all (or paused) pipelines.\n' +
        '• **`/preview-spintax`** — Dry-run 4 random Spintax variations before going live.\n' +
        '• **`/add-token`** — Register, list, or purge your account session credentials.\n' +
        '• **`/add-config`** — Create a new automated posting configuration.\n' +
        '• **`/duplicate-config`** — Clone an existing pipeline message and interval onto a new channel.\n' +
        '• **`/allow-copy-config`** — Toggle your controller template sharing status on/off.\n' +
        '• **`/copy-controller`** — Mirror another operator\'s shared controller pipelines.',
    },
    {
      name: '🔑 Administration & Management Tools',
      value:
        '• **`/store`** — Publish the official AutomateX license pricing and store showcase embed *(Admin)*.\n' +
        '• **`/set-trial-duration`** — Configure the active free trial duration in days *(Admin)*.\n' +
        '• **`/set-price`** — Configure the base Lifetime Diamond Lock price *(Admin)*.\n' +
        '• **`/check-access`** — Verify subscription clearance and expiration status of a user *(Admin)*.\n' +
        '• **`/grant-access`** — Authorize a user with a specific subscription duration tier *(Admin)*.\n' +
        '• **`/extend-access`** — Add extra time to an active user without wiping their setup *(Admin)*.\n' +
        '• **`/revoke-access`** — Terminate clearance, purge credentials, and wipe user pipelines *(Admin)*.\n' +
        '• **`/promotion`** — Broadcast the official AutomateX launch and setup announcement embed *(Admin)*.\n' +
        '• **`/terms-of-service`** — Publish the official legal terms of service embed *(Admin)*.',
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