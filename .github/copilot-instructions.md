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
npm run dev               # tsx watch src/server.ts
npm run build             # tsc -p tsconfig.build.json → dist/
npm start                 # node dist/server.js
npm run typecheck         # tsc --noEmit (tsx does not type-check)
npm test                  # Node's built-in runner, using tsx for TypeScript
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
node --import tsx --test --test-name-pattern="verification echoes" tests/webhook.test.ts
npm run lint              # ESLint with typescript-eslint strictTypeChecked
npm run format:check      # Prettier
npm run prisma:generate   # generates src/generated/prisma (gitignored)
docker compose up -d --wait   # PostgreSQL 18 + Redis 8
```

Bootstrap and webhook tests need no database or Redis. Production startup
requires a non-empty `WHATSAPP_VERIFY_TOKEN`; tests inject synthetic configuration.

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
- Read configuration through the validated `env` object in `src/config/env.ts`,
  not `process.env`. `src/server.ts` constructs the logger and injects it and
  the token into `createApp({ logger, whatsappVerifyToken })`. Keep `app.ts`
  free of `listen()` and environment loading so tests can use isolated dependencies.

## Current webhook phase

- Phase 1 is receiving and validation only. Do not interpret the target
  persistence/queue/AI flow below as implemented behavior.
- `WebhookController` owns GET verification and POST acknowledgement.
  `parseWebhookPayload(unknown)` validates the complete batch before logging
  and returns only modeled fields. Unknown fields are accepted but not logged.
- `eventType` is `change.field`; `phoneNumber` is an optional message sender
  (`from`); `messageId` is `message.id`. The transport `Message` interface is
  not a database/domain model.
- Never log raw request bodies, verification queries, or headers. HTTP logs
  omit query strings and headers; webhook logs contain the validated projection.
- POSTs are not yet signature-authenticated. Default to local examples; the
  README's temporary tunnel walkthrough is only for isolated, synthetic
  dashboard tests. Real customer traffic or production deployment requires HTTPS and Meta
  signature verification. Do not open a tunnel or change external accounts
  automatically when the user asks for setup instructions.
- Add each new test file to the explicit file list in the `npm test` script.

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
  token, then echoes the challenge as plain text. In Phase 1, POST only validates,
  logs sanitized metadata, and returns 200; malformed requests return 400 and
  unexpected errors return 500.
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
