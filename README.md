# liteBot

A backend for a **WhatsApp AI assistant**, built as a learning project. It starts as a
small proof of concept, but is organised so it can grow into a distributed,
multi-region system without a rewrite.

> **Current status: Stage 1 — Bootstrap.** The project compiles, runs, and exposes
> `GET /health`. It does not yet receive WhatsApp messages or call AI. See
> [Implementation phases](#implementation-phases).

New here? Read the [learning guide](docs/README.md). It explains each stage from
first principles, in the order it was built. The full target requirements live in
[AGENTS.md](AGENTS.md); they describe the goal, not what exists today.

## What it will do

1. A person sends a WhatsApp message.
2. Meta's WhatsApp Cloud API forwards it to our **webhook**.
3. We save the message and put a **job** on a queue, then reply to Meta at once.
4. A separate **worker** process picks up the job, loads the conversation history,
   asks **Azure OpenAI** for a reply, saves it, and sends it back through WhatsApp.

## Architecture vision

```text
 WhatsApp user
      │
      ▼
 WhatsApp Cloud API (Meta)
      │  HTTPS webhook
      ▼
 ┌──────────────────┐   save message   ┌────────────┐
 │  Webhook API     │ ───────────────▶ │ PostgreSQL │
 │  (Express)       │                  └────────────┘
 └──────────────────┘                        ▲
      │ enqueue job                          │ history / replies
      ▼                                      │
 ┌──────────────────┐   pick up job    ┌─────┴──────┐
 │ BullMQ on Redis  │ ───────────────▶ │   Worker   │
 └──────────────────┘                  └────────────┘
                                         │        │
                                         ▼        ▼
                                 Azure OpenAI   WhatsApp Cloud API
```

Why split the API from the worker? Meta expects a fast reply to every webhook
call, while AI responses can take seconds. The API only records and enqueues;
the slow work happens elsewhere. The two can also be scaled independently.

## Tech stack

| Concern         | Choice                                             |
| --------------- | -------------------------------------------------- |
| Runtime         | Node.js 22.13+ on 22.x, or 24+ (native ES modules) |
| Language        | TypeScript 6 (strict)                              |
| HTTP framework  | Express 5                                          |
| Database        | PostgreSQL 18, accessed through Prisma 7           |
| Queue and cache | Redis 8 with BullMQ                                |
| AI              | Azure OpenAI via the `openai` SDK                  |
| Logging         | Pino and pino-http                                 |
| Local services  | Docker Compose                                     |
| Code quality    | ESLint (typed rules) and Prettier                  |

## Local setup

**Prerequisites:** Node.js 22.13+ on the 22.x release line, or Node.js 24+, npm,
and Docker Desktop (running). The minimum matches ESLint's supported Node versions.

```powershell
# 1. Install dependencies
npm ci

# 2. Create your local environment file
Copy-Item .env.example .env        # macOS/Linux: cp .env.example .env

# 3. Start PostgreSQL and Redis
docker compose up -d --wait

# 4. Generate the Prisma client
npm run prisma:generate

# 5. Run the API with auto-reload
npm run dev
```

Check it works:

```powershell
curl http://localhost:3000/health
# {"status":"healthy"}
```

Stop the services with `docker compose down` (add `-v` to delete their data).
Their default ports are published only on `127.0.0.1`; the example database
credentials and unauthenticated Redis are for local development, not deployment.

See the [dependency notes](docs/01-bootstrap.md#version-choices) for the agreed
version exceptions, BullMQ's transitive deprecation warning, and a deferred
development-only lint dependency advisory.

## Commands

| Command                   | What it does                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`             | Run `src/server.ts` with tsx, restarting on change                           |
| `npm run build`           | Compile `src/` to JavaScript in `dist/`                                      |
| `npm start`               | Run the compiled server from `dist/`                                         |
| `npm run typecheck`       | Type-check without writing files                                             |
| `npm test`                | Run the bootstrap smoke and startup regression tests with Node's test runner |
| `npm run lint`            | Run ESLint                                                                   |
| `npm run format`          | Format all files with Prettier                                               |
| `npm run format:check`    | Report formatting problems without changing files                            |
| `npm run prisma:generate` | Generate the Prisma client into `src/generated/`                             |

To run only the startup regression test:

```powershell
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
```

These two tests require neither PostgreSQL nor Redis. Broader tests arrive with
the later stages.

## Environment variables

Defined in [`.env.example`](.env.example). Copy it to `.env`; never commit `.env`.

| Variable                   | Used from | Purpose                                               |
| -------------------------- | --------- | ----------------------------------------------------- |
| `PORT`                     | Stage 1   | HTTP port (default `3000`)                            |
| `LOG_LEVEL`                | Stage 1   | Pino log level (default `info`)                       |
| `DATABASE_URL`             | Stage 1   | PostgreSQL connection string, read by Prisma          |
| `REDIS_HOST`, `REDIS_PORT` | Later     | Redis location for BullMQ and caching                 |
| `AZURE_OPENAI_*`           | Later     | Endpoint, API key, and deployment name for AI replies |
| `WHATSAPP_VERIFY_TOKEN`    | Later     | Secret that Meta echoes when verifying the webhook    |
| `WHATSAPP_ACCESS_TOKEN`    | Later     | Token for calling the WhatsApp Cloud API              |
| `WHATSAPP_PHONE_NUMBER_ID` | Later     | The WhatsApp business number that sends replies       |

## Project layout

```text
src/
├── server.ts          Starts the HTTP server; handles shutdown signals
├── app.ts             Builds the Express app (middleware + routes)
├── config/            Environment parsing and the shared logger
├── routes/            URL → handler wiring (currently /health)
├── controllers/       HTTP request handlers            (later stage)
├── services/          Application logic                (later stage)
├── repositories/      Database access via Prisma       (later stage)
├── providers/         Azure OpenAI and WhatsApp clients (later stage)
├── queues/            BullMQ queue definitions         (later stage)
├── workers/           Background job processors        (later stage)
├── middleware/        Correlation IDs, error handling  (later stage)
├── shared/            Cross-cutting types, constants, utilities
└── generated/         Prisma client output (generated; not committed)
prisma/                Database schema and, later, migrations
docs/                  Learning guide, one chapter per stage
```

## Implementation phases

| Stage | Focus                                                                   | Status  |
| ----- | ----------------------------------------------------------------------- | ------- |
| 1     | Bootstrap: tooling, Express, logging, Prisma, Docker Compose            | ✅ Done |
| 2     | Data model: `User`, `Conversation`, `Message`, migrations, repositories | Planned |
| 3     | HTTP foundations: correlation IDs, error middleware, tests              | Planned |
| 4     | WhatsApp webhook: verification and validated inbound messages           | Planned |
| 5     | Queueing: BullMQ job on receipt, separate worker process                | Planned |
| 6     | AI replies: provider interface, Azure OpenAI, conversation cache        | Planned |
| 7     | Outbound WhatsApp provider placeholder and end-to-end flow              | Planned |

The order may change as we learn; this table will be kept current.

## Scalability roadmap

Today the target is a single region: Express, BullMQ, and PostgreSQL. The layer
boundaries above are what let it grow:

- **Azure Front Door** routes users to the nearest healthy region.
- **Kafka or Azure Event Hubs** replaces BullMQ when throughput or cross-region
  delivery outgrows a single Redis.
- **Multi-region workers** consume from the shared event stream.
- **Redis Cluster** shards caching and coordination.
- **A globally distributed database** replaces the single PostgreSQL instance;
  the choice will depend on consistency, residency, and latency requirements.

Each step will be explained in the learning guide when we reach it.

## License

[MIT](LICENSE)
