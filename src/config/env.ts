import 'dotenv/config';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export interface Env {
  readonly port: number;
  readonly logLevel: LogLevel;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${String(value)}"`);
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

// TODO(later stages): validate DATABASE_URL, Redis, WhatsApp, and Azure OpenAI settings
// when the features that need them are introduced.
export const env: Env = Object.freeze({
  port: parsePort(process.env.PORT),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
});
