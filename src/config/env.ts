import 'dotenv/config';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export interface Env {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly whatsappVerifyToken: string;
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

function parseVerifyToken(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error('WHATSAPP_VERIFY_TOKEN must be configured with a non-empty value');
  }
  return value;
}

// TODO(later stages): validate DATABASE_URL, Redis, WhatsApp sending, and Azure OpenAI settings
// when the features that need them are introduced.
export const env: Env = Object.freeze({
  port: parsePort(process.env.PORT),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  whatsappVerifyToken: parseVerifyToken(process.env.WHATSAPP_VERIFY_TOKEN),
});
