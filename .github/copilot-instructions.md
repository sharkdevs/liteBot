# Repository context

liteBot is a starter backend for a WhatsApp AI assistant, intended to grow from a
small proof of concept into a distributed, multi-region system.

Read `AGENTS.md` for the target requirements; `README.md` explicitly points to it.
Those requirements describe the goal, not the current implementation. Check the
"Implementation phases" table in `README.md` and the chapters in `docs/` to see
which stages exist; do not treat unimplemented target behavior as present.

## Staged learning workflow

This repository is a learning project. Deliver it in stages rather than building
the entire target system at once.

- Each stage's PR must include clear Markdown documentation explaining what
  changed, why it was needed, how it works, and how to run and verify it.
- Explain new concepts, terminology, and design decisions without assuming prior
  knowledge. Connect each stage to what earlier stages established.
- Evolve the repository's Markdown documentation in each stage's PR, not only
  the PR description. Keep it accurate as the implementation changes so a reader
  can eventually understand the system end to end from the documentation alone.
  Each stage adds a numbered chapter in `docs/` (for example `docs/01-bootstrap.md`),
  links it from `docs/README.md`, adds new terms to its glossary, and updates the
  phase table in `README.md`.

## Commands

```powershell
npm run dev               # API: tsx watch src/server.ts
npm run dev:worker        # Worker: tsx watch src/worker.ts (separate process)
npm run build             # tsc -p tsconfig.build.json → dist/
npm start                 # node dist/server.js
npm run start:worker      # node dist/worker.js
npm run typecheck         # tsc --noEmit (tsx does not type-check)
npm test                  # Node's built-in runner, using tsx for TypeScript (no Redis)
npm run test:integration  # real BullMQ against local Redis (TEST_REDIS_PORT, default 6379)
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
node --import tsx --test --test-name-pattern="verification echoes" tests/webhook.test.ts
npm run lint              # ESLint with typescript-eslint strictTypeChecked
npm run format:check      # Prettier
npm run prisma:generate   # generates src/generated/prisma (gitignored)
docker compose up -d --wait   # PostgreSQL 18 + Redis 8
```

`npm test` (bootstrap, webhook, config) needs no database or Redis; webhook tests
inject an in-memory queue. `npm run test:integration` needs Redis
(`docker compose up -d --wait redis`); each test uses a random BullMQ key prefix
and deletes only its own keys. Never flush or stop the shared Compose Redis from
tests. API startup requires a non-empty `WHATSAPP_VERIFY_TOKEN`; tests inject
synthetic configuration. Put Node test-runner options before file names.

## Toolchain constraints

- Supported Node versions are `^22.13.0 || >=24.0.0`, matching the lint toolchain.
- Native ESM (`"type": "module"`, `NodeNext`): relative imports must use `.js`
  extensions, and type-only imports need `import type` (`verbatimModuleSyntax`).
- Dependencies are pinned to exact versions. Use the latest stable releases and
  avoid deprecated packages; justify any exception in the stage's docs chapter.
- TypeScript is held at 6.0.x because `typescript-eslint` supports `<6.1`.
- Prisma 7 reads `DATABASE_URL` through `prisma.config.ts`, not the schema;
  the `prisma-client` generator outputs to `src/generated/prisma`, and runtime
  connections use `@prisma/adapter-pg`.
- Read configuration through the validated loaders in `src/config/env.ts`, not
  `process.env`: `loadApiEnv()` (port, verify token, log level, Redis) for
  `src/server.ts` and `loadWorkerEnv()` (log level, Redis only) for
  `src/worker.ts`. `server.ts` constructs the logger, Redis connection, and
  `IncomingMessageQueue`, then injects them into
  `createApp({ logger, whatsappVerifyToken, incomingMessageQueue })`. Keep
  `app.ts` free of `listen()`, environment loading, and Redis construction so
  tests can use isolated dependencies.

## Current implementation (Phase 2: queue infrastructure)

- Implemented: GET verification, POST validation, enqueueing supported text
  messages to BullMQ queue `incoming-messages`, and a separate worker that only
  logs. Not implemented: PostgreSQL persistence, AI, caching, or WhatsApp sending.
  Do not interpret the target flow below as implemented behavior.
- `WebhookController` owns GET verification and POST handling.
  `parseWebhookPayload(unknown)` validates the complete batch before logging or
  enqueueing and returns only modeled fields. Only `field: "messages"` +
  `type: "text"` + `from` messages become `IncomingMessageJob`s; others are
  acknowledged with 200 and logged as `Webhook message not queued` with a reason.
- The controller depends on `IncomingMessageQueuePort`, not BullMQ. The BullMQ
  producer adds jobs one at a time with `queue.add`. Do not switch to `addBulk`
  or other multi/pipeline paths: BullMQ 6.7.6's node-redis adapter has no
  `NOSCRIPT` fallback there, so they fail permanently after a Redis restart
  (covered by an integration test using `SCRIPT FLUSH`).
- Jobs use 3 attempts with exponential backoff (1000 ms). Producer connections
  disable the offline queue and use a 2 s command timeout; worker connections
  keep the offline queue and have no command timeout (blocking reads). On
  shutdown, close BullMQ objects before disconnecting Redis; the worker uses
  `worker.close(true)` when Redis is not ready so shutdown cannot hang.
- `eventType` is `change.field`; `phoneNumber` is the message sender (`from`);
  `messageId` is `message.id`. The transport `Message` interface is not a
  database/domain model.
- `x-correlation-id` is reused when it matches `^[a-zA-Z0-9._-]{1,128}$`,
  otherwise generated, echoed in the response, and carried inside each job so
  worker logs share it. `userId`/`conversationId` do not exist until the DB phase.
- Never log raw request bodies, verification queries, headers, or message text;
  worker logs redact `messageText`. HTTP logs omit query strings and headers.
- POSTs are not yet signature-authenticated. Default to local examples; the
  README's temporary tunnel walkthrough is only for isolated, synthetic
  dashboard tests. Real customer traffic or production deployment requires HTTPS and Meta
  signature verification. Do not open a tunnel or change external accounts
  automatically when the user asks for setup instructions.
- Add each new unit test file to the explicit file list in the `npm test` script;
  Redis-dependent tests belong in `test:integration`.
- BullMQ does not start workers; they are started manually today. Automatic
  startup (containers, restart policies) and queue-based autoscaling are
  deliberately deferred until the proof of concept runs end to end (Chapter 3,
  section 13). Do not add Dockerfiles or scaling configuration unless asked.

## Target architecture

- Use Node.js 22+, strict TypeScript, and Express. Keep API, queue, domain,
  infrastructure, and worker layers distinct, with dependencies suitable for
  constructor injection and a future NestJS migration.
- Keep webhook handling thin: validate inbound events, persist messages, enqueue
  BullMQ work, and respond promptly. Workers load conversation history, build the
  prompt, call AI, save the response, and invoke the WhatsApp provider.
- Put PostgreSQL/Prisma persistence behind repositories. Use Redis for BullMQ and
  conversation caching, with a cache-service abstraction rather than direct
  Redis access from business logic.
- Put Azure OpenAI and WhatsApp Cloud API behind provider interfaces.
  `IAiProvider.generateResponse(userMessage, conversationHistory)` is the required
  AI contract; inject the Azure implementation through constructors.
  WhatsApp sending must remain an interface and placeholder, not a live sender.
- Model `User` (`id`, `phoneNumber`, `createdAt`), `Conversation` (`id`, `userId`,
  `createdAt`, `updatedAt`), and `Message` (`id`, `conversationId`, `direction`,
  `content`, `createdAt`). Message direction is `INBOUND` or `OUTBOUND`.

## Project-specific contracts

- Stage 1's `GET /health` returns exactly `{"status":"healthy"}`.
  The target in `AGENTS.md` adds `"service":"whatsapp-ai-assistant"` in a later stage.
- `GET /webhook` verifies `hub.mode=subscribe` and the environment-provided
  token, then echoes the challenge as plain text. POST returns 200 after Redis
  accepts any jobs; malformed requests return 400, and queue failures or
  unexpected errors return a generic 500 so Meta retries.
- Attach an `x-correlation-id` to every request. Use Pino and include
  `correlationId`, `userId`, and `conversationId` in relevant logs when available.
  Route errors through centralized error middleware; do not use `console.log`.
- Keep TypeScript strict, avoid `any`, and use async/await.
- Supply `.env.example` for server port, database, Redis, WhatsApp, and Azure
  OpenAI configuration. `.gitignore` excludes `.env` and `.env.*` but explicitly
  allows `.env.example`.
- Local infrastructure uses Docker Compose for PostgreSQL and Redis; persistence
  changes should include Prisma migrations. ESLint and Prettier are configured.
- As implementation lands, document setup, environment variables, architecture,
  and separate worker startup in `README.md`. Preserve the roadmap toward Azure
  Front Door, Kafka or Event Hubs, multi-region workers, Redis Cluster, and a
  globally distributed database.
