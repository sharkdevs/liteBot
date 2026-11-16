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
npm test                  # Node's built-in runner, using tsx for TypeScript (no Redis or PostgreSQL)
npm run test:integration  # real BullMQ (Redis) and real persistence (PostgreSQL, throwaway DB)
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
node --import tsx --test --test-name-pattern="verification echoes" tests/webhook.test.ts
node --import tsx --test --test-name-pattern="simultaneous" tests/persistence.integration.test.ts
npm run lint              # ESLint with typescript-eslint strictTypeChecked
npm run format:check      # Prettier
npm run prisma:generate   # generates src/generated/prisma (gitignored)
npm run prisma:migrate:deploy # applies committed migrations (prisma migrate deploy)
npm run prisma:migrate -- --name <name> --create-only # new draft migration (interactive terminal only)
docker compose up -d --wait   # PostgreSQL 18 + Redis 8
```

`npm test` (bootstrap, webhook, config) needs no database or Redis; webhook tests
inject a fake conversation service and an in-memory queue.
`npm run test:integration` needs Redis and PostgreSQL (`docker compose up -d --wait`).
Queue tests use a random BullMQ key prefix and delete only their own keys;
persistence tests create a `litebot_test_<hex>` database via `TEST_DATABASE_URL`,
apply migrations with `prisma migrate deploy`, and drop it afterwards. Never
flush or stop the shared Compose Redis or touch the development database from
tests. API startup requires a non-empty `WHATSAPP_VERIFY_TOKEN` and a PostgreSQL
`DATABASE_URL`; tests inject synthetic configuration. Put Node test-runner
options before file names.

`prisma migrate dev` refuses non-interactive shells. To draft a migration
there, print SQL with
`npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
(compares the `DATABASE_URL` database to the schema), save it in a new
timestamped `prisma/migrations/<UTC timestamp>_<name>/migration.sql`, and apply
with `npm run prisma:migrate:deploy`. Never edit an applied migration; add a new
one, and hand-edit it (nullable → backfill → `SET NOT NULL`) when adding a
required column to a table that may have rows.

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
  `process.env`: `loadApiEnv()` (port, verify token, log level, Redis, database
  URL) for `src/server.ts` and `loadWorkerEnv()` (log level, Redis only) for
  `src/worker.ts`. `server.ts` is the composition root: it constructs the
  logger, Prisma client, Redis connection, `IncomingMessageQueue`, and
  `ConversationService(new PrismaUnitOfWork(prisma), logger)`, then injects them
  into `createApp({ logger, whatsappVerifyToken, conversationService, incomingMessageQueue })`.
  Keep `app.ts` free of `listen()`, environment loading, and Redis or Prisma
  construction so tests can use isolated dependencies.

## Current implementation (Phase 3: persistence layer)

- Implemented: GET verification, POST validation, saving each supported text
  message (with its user and conversation) in PostgreSQL, then enqueueing it to
  BullMQ queue `incoming-messages`, and a separate worker that only logs. Not
  implemented: AI, caching, WhatsApp sending, status-webhook processing, or
  signature verification. Do not interpret the target flow below as implemented
  behavior.
- `WebhookController` owns GET verification and POST handling.
  `parseWebhookPayload(unknown)` validates the complete batch before logging or
  saving and returns only modeled fields. Only `field: "messages"` +
  `type: "text"` + `from` messages are saved and queued; others are
  acknowledged with 200 and logged as `Webhook message not queued` with a reason.
  Message timestamps must be Unix seconds within the JavaScript `Date` range.
- Save first, then queue. `ConversationService.recordInboundMessage()` runs one
  transaction per message through the `IUnitOfWork`, serialized per sender with
  a PostgreSQL transaction-level advisory lock: find or create the user, find
  the user's latest conversation or create one, then save the `INBOUND` message.
  A known `whatsappMessageId` returns the existing IDs (`duplicate: true`); the
  same ID from another sender throws `WhatsappMessageIdConflictError` (500).
  Services and controllers never import Prisma; repositories map Prisma rows to
  domain types in `src/domain/`.
- `Conversation` mirrors **WhatsApp** conversation metadata
  (`whatsappConversationId` unique nullable, `category`, `originType`,
  `expiresAt`, plus `startedAt` = the first stored message's WhatsApp
  timestamp). Never create conversations from inactivity windows or business
  rules. Inbound webhooks carry no conversation data, so the metadata stays NULL
  until status webhooks are processed. AI memory or assistant threads must be a
  separate concept, not overloaded onto `Conversation`.
- The controller depends on `IConversationService` and
  `IncomingMessageQueuePort`, not Prisma or BullMQ. The BullMQ producer adds jobs
  one at a time with `queue.add` and `jobId` = the saved message's database ID.
  Do not switch to `addBulk` or other multi/pipeline paths: BullMQ 6.7.6's
  node-redis adapter has no `NOSCRIPT` fallback there, so they fail permanently
  after a Redis restart (covered by an integration test using `SCRIPT FLUSH`).
- Jobs use 3 attempts with exponential backoff (1000 ms). Producer connections
  disable the offline queue and use a 2 s command timeout; worker connections
  keep the offline queue and have no command timeout (blocking reads). On
  shutdown, close BullMQ objects before disconnecting Redis; the worker uses
  `worker.close(true)` when Redis is not ready so shutdown cannot hang.
- `eventType` is `change.field`; `phoneNumber` is the message sender (`from`);
  in logs and jobs, `whatsappMessageId` is Meta's `message.id` and `messageId`
  is our database ID. The transport `Message` interface in
  `src/shared/types/` is not the domain `Message`.
- `x-correlation-id` is reused when it matches `^[a-zA-Z0-9._-]{1,128}$`,
  otherwise generated, echoed in the response, and carried inside each job so
  worker logs share it. Jobs and logs also carry `userId`, `conversationId`,
  and `messageId`; services log only after the transaction commits.
- Never log raw request bodies, verification queries, headers, or message text;
  worker logs redact `messageText`. HTTP logs omit query strings and headers.
- POSTs are not yet signature-authenticated. Default to local examples; the
  README's temporary tunnel walkthrough is only for isolated, synthetic
  dashboard tests. Real customer traffic or production deployment requires HTTPS and Meta
  signature verification. Do not open a tunnel or change external accounts
  automatically when the user asks for setup instructions.
- Add each new unit test file to the explicit file list in the `npm test` script;
  Redis- or PostgreSQL-dependent tests belong in `test:integration`.
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
- Model `User` (`id`, `phoneNumber` unique, `createdAt`, `updatedAt`),
  `Conversation` (WhatsApp conversation metadata, as above), and `Message`
  (`id`, `conversationId`, `whatsappMessageId` unique nullable, `direction`,
  `content`, `createdAt`). Message direction is `INBOUND` or `OUTBOUND`.

## Project-specific contracts

- Stage 1's `GET /health` returns exactly `{"status":"healthy"}`.
  The target in `AGENTS.md` adds `"service":"whatsapp-ai-assistant"` in a later stage.
- `GET /webhook` verifies `hub.mode=subscribe` and the environment-provided
  token, then echoes the challenge as plain text. POST returns 200 after the
  messages are saved and Redis accepts any jobs; malformed requests return 400,
  and database, queue, or unexpected errors return a generic 500 so Meta retries.
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
