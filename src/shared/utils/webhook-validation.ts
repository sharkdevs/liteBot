import type {
  Message,
  WebhookChange,
  WebhookEntry,
  WebhookPayload,
} from '../types/webhook.types.js';
import { BadRequestError } from './bad-request-error.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseMessage(input: unknown): Message {
  if (!isRecord(input) || !isNonEmptyString(input.id)) {
    throw new BadRequestError('A message must have a non-empty string id');
  }
  const message: Message = { id: input.id };
  if ('from' in input) {
    if (!isNonEmptyString(input.from)) {
      throw new BadRequestError('A message phone number must be a non-empty string when provided');
    }
    message.from = input.from;
  }
  if ('type' in input) {
    if (!isNonEmptyString(input.type)) {
      throw new BadRequestError('A message type must be a non-empty string when provided');
    }
    message.type = input.type;
  }
  if (message.type === 'text') {
    if (!isRecord(input.text) || !isNonEmptyString(input.text.body)) {
      throw new BadRequestError('A text message must have a non-empty text body');
    }
    if (
      typeof input.timestamp !== 'string' ||
      !/^\d+$/.test(input.timestamp) ||
      !Number.isSafeInteger(Number(input.timestamp))
    ) {
      throw new BadRequestError('A text message timestamp must be a Unix-seconds string');
    }
    message.text = { body: input.text.body };
    message.timestamp = input.timestamp;
  }
  return message;
}

function parseChange(input: unknown): WebhookChange {
  if (!isRecord(input) || !isNonEmptyString(input.field) || !isRecord(input.value)) {
    throw new BadRequestError('A change must have a field and an object value');
  }
  const change: WebhookChange = { field: input.field, value: {} };
  if ('messages' in input.value) {
    if (!Array.isArray(input.value.messages)) {
      throw new BadRequestError('Messages must be an array when provided');
    }
    change.value.messages = input.value.messages.map(parseMessage);
  }
  return change;
}

function parseEntry(input: unknown): WebhookEntry {
  if (
    !isRecord(input) ||
    !isNonEmptyString(input.id) ||
    !Array.isArray(input.changes) ||
    input.changes.length === 0
  ) {
    throw new BadRequestError('An entry must have an id and a non-empty changes array');
  }
  return { id: input.id, changes: input.changes.map(parseChange) };
}

// Validate the full batch before any message can be enqueued.
export function parseWebhookPayload(input: unknown): WebhookPayload {
  if (
    !isRecord(input) ||
    input.object !== 'whatsapp_business_account' ||
    !Array.isArray(input.entry) ||
    input.entry.length === 0
  ) {
    throw new BadRequestError('Expected a WhatsApp business account envelope with entries');
  }
  return { object: 'whatsapp_business_account', entry: input.entry.map(parseEntry) };
}
