import 'dotenv/config';

import type { RedisSettings } from './redis.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export interface WorkerEnv {
  readonly logLevel: LogLevel;
  readonly redis: RedisSettings;
}

export interface Env extends WorkerEnv {
  readonly port: number;
  readonly whatsappVerifyToken: string;
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

// The error never repeats the value, because a connection string contains a password.
function parseDatabaseUrl(value: string | undefined): string {
  const protocol = value?.trim() ? URL.parse(value)?.protocol : undefined;
  if (value === undefined || (protocol !== 'postgresql:' && protocol !== 'postgres:')) {
    throw new Error('DATABASE_URL must be a postgresql:// connection string');
  }
  return value;
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
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

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Object.freeze({
    port: parsePort(source.PORT, 'PORT', 3000),
    whatsappVerifyToken: parseVerifyToken(source.WHATSAPP_VERIFY_TOKEN),
    ...loadWorkerEnv(source),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
  });
}

// TODO(later stages): validate WhatsApp sending and AI settings when used.
