import 'dotenv/config';

import type { RedisSettings } from './redis.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const AI_PROVIDERS = ['azure-foundry', 'openai', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AzureFoundrySettings {
  readonly provider: 'azure-foundry';
  readonly endpoint: string;
  readonly apiKey: string;
  readonly modelName: string;
}

export interface PlaceholderAiSettings {
  readonly provider: 'openai' | 'gemini';
  readonly modelName: 'openai' | 'gemini';
}

export type AiSettings = AzureFoundrySettings | PlaceholderAiSettings;

interface RuntimeEnv {
  readonly logLevel: LogLevel;
  readonly redis: RedisSettings;
}

export interface ReconciliationEnv extends RuntimeEnv {
  readonly databaseUrl: string;
}

export interface WorkerEnv extends RuntimeEnv {
  readonly databaseUrl: string;
  readonly ai: AiSettings;
}

export interface WhatsAppSettings {
  readonly accessToken: string;
  readonly phoneNumberId: string;
}

export interface WhatsAppWorkerEnv extends RuntimeEnv {
  readonly databaseUrl: string;
  readonly whatsapp: WhatsAppSettings;
}

export interface Env extends RuntimeEnv {
  readonly port: number;
  readonly whatsappVerifyToken: string;
  readonly whatsappAppSecret: string;
  readonly databaseUrl: string;
}

function parsePort(value: string | undefined, name: string, defaultPort: number): number {
  const port = Number(value ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, received "${String(value)}"`);
  }
  return port;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? 'info';
  if (!LOG_LEVELS.includes(level as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, received "${level}"`);
  }
  return level as LogLevel;
}

function parseVerifyToken(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error('WHATSAPP_VERIFY_TOKEN must be configured with a non-empty value');
  }
  return value;
}

function parseAppSecret(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('WHATSAPP_APP_SECRET must be configured with a non-empty value');
  }
  return value;
}

// The error never repeats the value, because a connection string contains a password.
function parseDatabaseUrl(value: string | undefined): string {
  const protocol = value?.trim() ? URL.parse(value)?.protocol : undefined;
  if (value === undefined || (protocol !== 'postgresql:' && protocol !== 'postgres:')) {
    throw new Error('DATABASE_URL must be a postgresql:// connection string');
  }
  return value;
}

function loadRuntimeEnv(source: NodeJS.ProcessEnv): RuntimeEnv {
  const host = source.REDIS_HOST ?? 'localhost';
  if (!host.trim()) {
    throw new Error('REDIS_HOST must be a non-empty hostname');
  }
  return Object.freeze({
    logLevel: parseLogLevel(source.LOG_LEVEL),
    redis: Object.freeze({
      host: host.trim(),
      port: parsePort(source.REDIS_PORT, 'REDIS_PORT', 6379),
    }),
  });
}

function parseAiProvider(value: string | undefined): AiProvider {
  const provider = value ?? 'azure-foundry';
  if (!AI_PROVIDERS.includes(provider as AiProvider)) {
    throw new Error(`AI_PROVIDER must be ${AI_PROVIDERS.join(', ')}`);
  }
  return provider as AiProvider;
}

function parseAiSettings(source: NodeJS.ProcessEnv): AiSettings {
  const provider = parseAiProvider(source.AI_PROVIDER);
  switch (provider) {
    case 'openai':
      return Object.freeze({ provider, modelName: provider });
    case 'gemini':
      return Object.freeze({ provider, modelName: provider });
    case 'azure-foundry':
      return Object.freeze({
        provider,
        endpoint: parseAzureFoundryEndpoint(source.AZURE_AI_FOUNDRY_ENDPOINT),
        apiKey: parseAzureFoundryApiKey(source.AZURE_AI_FOUNDRY_API_KEY),
        modelName: parseAzureAiModel(source.AZURE_AI_MODEL),
      });
  }
}

function parseAzureFoundryEndpoint(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('AZURE_AI_FOUNDRY_ENDPOINT must be configured');
  }
  const endpoint = URL.parse(value.trim());
  if (
    endpoint?.protocol !== 'https:' ||
    !endpoint.hostname ||
    endpoint.pathname.replace(/\/+$/, '') !== '/openai/v1' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('AZURE_AI_FOUNDRY_ENDPOINT must be a valid HTTPS Foundry OpenAI v1 URL');
  }
  return value.trim();
}

function parseAzureFoundryApiKey(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('AZURE_AI_FOUNDRY_API_KEY must be configured');
  }
  return value;
}

function parseAzureAiModel(value: string | undefined): string {
  if (value !== undefined && !value.trim()) {
    throw new Error('AZURE_AI_MODEL must be a non-empty model name');
  }
  return value?.trim() ?? 'phi-4-mini';
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return Object.freeze({
    ...loadRuntimeEnv(source),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
    ai: parseAiSettings(source),
  });
}

export function loadReconciliationEnv(source: NodeJS.ProcessEnv = process.env): ReconciliationEnv {
  return Object.freeze({
    ...loadRuntimeEnv(source),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
  });
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Object.freeze({
    port: parsePort(source.PORT, 'PORT', 3000),
    whatsappVerifyToken: parseVerifyToken(source.WHATSAPP_VERIFY_TOKEN),
    whatsappAppSecret: parseAppSecret(source.WHATSAPP_APP_SECRET),
    ...loadRuntimeEnv(source),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
  });
}

export function loadWhatsAppWorkerEnv(source: NodeJS.ProcessEnv = process.env): WhatsAppWorkerEnv {
  const accessToken = source.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = source.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!accessToken || !/^[!-~]+$/.test(accessToken)) {
    throw new Error('WHATSAPP_ACCESS_TOKEN must be a non-empty token without whitespace');
  }
  if (!phoneNumberId || !/^[0-9]+$/.test(phoneNumberId)) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID must be a numeric business phone number ID');
  }
  return Object.freeze({
    ...loadRuntimeEnv(source),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
    whatsapp: Object.freeze({ accessToken, phoneNumberId }),
  });
}
