# Repository context

liteBot is a starter backend for a WhatsApp AI assistant, intended to grow from a
small proof of concept into a distributed, multi-region system.

Read `AGENTS.md` for the target requirements; `README.md` explicitly points to it.
The repository currently contains documentation only, with no application source,
package manifest, or configured build, test, or lint tooling. Do not treat the
target architecture as implemented behavior.

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

## Commands

No build, test, lint, or single-test commands are defined yet. When tooling is
introduced, document the actual commands from its configuration here, including
how to select one test.

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

- `GET /health` must return
  `{"status":"healthy","service":"whatsapp-ai-assistant"}`.
- `GET /webhook` must support Meta verification using an environment-provided
  verification token; `POST /webhook` follows the asynchronous flow above.
- Attach an `x-correlation-id` to every request. Use Pino and include
  `correlationId`, `userId`, and `conversationId` in relevant logs when available.
  Route errors through centralized error middleware; do not use `console.log`.
- Keep TypeScript strict, avoid `any`, and use async/await.
- Supply `.env.example` for server port, database, Redis, WhatsApp, and Azure
  OpenAI configuration. `.gitignore` excludes `.env` and `.env.*` but explicitly
  allows `.env.example`.
- Local infrastructure is intended to use Docker Compose for PostgreSQL and
  Redis; persistence changes should include Prisma migrations. ESLint and
  Prettier are the intended linting and formatting tools.
- As implementation lands, document setup, environment variables, architecture,
  and separate worker startup in `README.md`. Preserve the roadmap toward Azure
  Front Door, Kafka or Event Hubs, multi-region workers, Redis Cluster, and a
  globally distributed database.
