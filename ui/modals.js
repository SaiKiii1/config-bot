// ui/modals.js
import { InteractionResponseType } from 'discord-interactions';
import { row } from './primitives.js';

export function delayModal(mode, id, current) {
  const has = current != null;
  const parts = has
    ? {
        hours: Math.floor(current / 3600),
        minutes: Math.floor((current % 3600) / 60),
        seconds: current % 60,
      }
    : {};

  const input = (custom_id, label, placeholder) =>
    row({
      type: 4,
      custom_id,
      label,
      style: 1,
      required: false,
      max_length: 5,
      placeholder,
      ...(has ? { value: String(parts[custom_id]) } : {}),
    });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:delay`,
      title: '⏱️ Set Execution Interval',
      components: [
        input('hours', 'Hours', '0'),
        input('minutes', 'Minutes', '0'),
        input('seconds', 'Seconds', '30'),
      ],
    },
  };
}

export function modal(mode, id, field, current) {
  if (field === 'delay') return delayModal(mode, id, current);

  const titles = {
    name: '✏️ Rename Configuration',
    channelId: '📍 Configure Target Channel ID',
    text: '💬 Define Dispatch Payload',
  };
  const labels = {
    name: 'Configuration Name',
    channelId: 'Destination Channel ID',
    text: 'Message Body',
  };

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `modal:${mode}:${id}:${field}`,
      title: titles[field],
      components: [
        row({
          type: 4,
          custom_id: 'value',
          label: labels[field],
          style: field === 'text' ? 2 : 1,
          min_length: 1,
          max_length: field === 'text' ? 2000 : 50,
          required: true,
          value: current != null ? String(current) : undefined,
        }),
      ],
    },
  };
}

export function credentialInputModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'modal:add-token:save',
      title: '🔐 Secure Credential Registration (Limit: 1)',
      components: [
        row({
          type: 4,
          custom_id: 'label_name',
          label: 'Token Profile Label',
          style: 1,
          required: true,
          max_length: 50,
          placeholder: 'e.g., My-Primary-Account',
        }),
        row({
          type: 4,
          custom_id: 'token_value',
          label: 'Discord Account Session Token',
          style: 1,
          required: true,
          min_length: 50,
          max_length: 200,
          placeholder: 'Paste session credential (encrypted at rest)',
        }),
      ],
    },
  };
}