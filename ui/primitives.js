// ui/primitives.js
import { InteractionResponseType, InteractionResponseFlags } from 'discord-interactions';

export const row = (...components) => ({ type: 1, components });
export const btn = (custom_id, label, style = 2, disabled = false) => ({
  type: 2,
  custom_id,
  label,
  style,
  disabled,
});

export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const quote = (t) => clip(t.split('\n').map((l) => `> ${l}`).join('\n'), 1024);
export const unix = (ms) => Math.floor(ms / 1000);

export function fmtDelay(s) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

export const reply = (res, data) =>
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...data },
  });

export const ephemeral = (res, content) => reply(res, { content });

export const notice = (res, color, title, description) =>
  reply(res, { embeds: [{ color, title, description }] });

export const notYours = (res) =>
  ephemeral(res, '🛡️ **Access Denied**: This configuration no longer exists or belongs to another security profile.');