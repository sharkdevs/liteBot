# liteBot

A backend for a **WhatsApp AI assistant**, built as a learning project. It starts as a
small proof of concept, but is organised so it can grow into a distributed,
multi-region system without a rewrite.

> **Current status: Phase 1 — WhatsApp Webhook Foundation.** On top of the
> bootstrap scaffold, `GET /webhook` verifies ownership and `POST /webhook`
> validates and logs sanitized event metadata, then acknowledges it. There is
> no persistence, queueing, message processing, or AI. See
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

This is the target architecture, not the current request path. Phase 1 stops
after validation and logging; the worker, database, queue, and AI flow is future work.

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

Why eventually split the API from the worker? Meta expects a fast reply to every
webhook call, while AI responses can take seconds. The API will record and enqueue;
the slow work will happen elsewhere. The two can then be scaled independently.

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

**Prerequisites:** Node.js 22.13+ on the 22.x release line, or Node.js 24+, and npm.
The minimum matches ESLint's supported Node versions. Docker is optional for this
phase: neither the server nor its tests connect to PostgreSQL or Redis.

```powershell
# 1. Install dependencies
npm ci

# 2. Create your local environment file only if it does not already exist
Copy-Item .env.example .env        # macOS/Linux: cp .env.example .env

# 3. Edit .env and set WHATSAPP_VERIFY_TOKEN to your own non-empty token.
#    An existing .env from the bootstrap stage needs this new setting too.

# 4. Run the API with auto-reload
npm run dev
```

Check it works:

```powershell
curl http://localhost:3000/health
# {"status":"healthy"}
```

Optional bootstrap tooling remains available:

```powershell
docker compose up -d --wait
npm run prisma:generate
```

Stop these services with `docker compose down` (add `-v` to delete their data).
Their default ports are published only on `127.0.0.1`; the example database
credentials and unauthenticated Redis are for local development, not deployment.

See the [dependency notes](docs/01-bootstrap.md#version-choices) for the agreed
version exceptions, BullMQ's transitive deprecation warning, and a deferred
development-only lint dependency advisory.

## Commands

| Command                   | What it does                                                 |
| ------------------------- | ------------------------------------------------------------ |
| `npm run dev`             | Run `src/server.ts` with tsx, restarting on change           |
| `npm run build`           | Compile `src/` to JavaScript in `dist/`                      |
| `npm start`               | Run the compiled server from `dist/`                         |
| `npm run typecheck`       | Type-check without writing files                             |
| `npm test`                | Run bootstrap and webhook HTTP tests with Node's test runner |
| `npm run lint`            | Run ESLint                                                   |
| `npm run format`          | Format all files with Prettier                               |
| `npm run format:check`    | Report formatting problems without changing files            |
| `npm run prisma:generate` | Generate the Prisma client into `src/generated/`             |

To run only the startup regression test:

```powershell
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
```

To run the webhook tests, or just the successful verification case:

```powershell
node --import tsx --test tests/webhook.test.ts
node --import tsx --test --test-name-pattern="verification echoes" tests/webhook.test.ts
```

Tests use synthetic tokens and require neither PostgreSQL nor Redis.

## Webhook Verification

### Why Meta verifies ownership

A callback URL is an address Meta will send events to. Anyone could enter an
arbitrary URL, so Meta first checks that its owner has intentionally configured
it for this subscription. Choose a private `WHATSAPP_VERIFY_TOKEN` in `.env` and
enter the same value in Meta's webhook configuration. This is a token **you
choose**, not the WhatsApp access token used for sending messages.

### How challenge-response works

Meta sends `GET /webhook` with three query parameters:

| Parameter          | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `hub.mode`         | Must be `subscribe`                        |
| `hub.verify_token` | Must exactly match `WHATSAPP_VERIFY_TOKEN` |
| `hub.challenge`    | Must be returned unchanged as plain text   |

A matching subscription gets `200` and the challenge itself, not JSON.
A wrong or missing token, or a wrong mode, gets `403`. A matching token with
a missing, empty, or repeated challenge gets `400`. Startup fails clearly
if the configured token is missing or blank.

For a local example, set `.env` to `WHATSAPP_VERIFY_TOKEN=local-example-token`
(only a demonstration value), restart the server, and run:

```powershell
Invoke-RestMethod 'http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=local-example-token&hub.challenge=123456'
# 123456
```

### GET versus POST

`GET /webhook` is the subscription handshake. `POST /webhook` carries JSON event
notifications after subscription. POST currently validates the envelope, logs
an allow-listed payload plus `eventType`, `phoneNumber`, and `messageId` when
available, and returns `200 OK`. It does not process or save messages.

```powershell
$payload = @'
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "local-business-account",
    "changes": [{
      "field": "messages",
      "value": {
        "messages": [{ "id": "wamid.local-example", "from": "15550000001" }]
      }
    }]
  }]
}
'@
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/webhook' -ContentType 'application/json' -Body $payload
# OK
```

Malformed envelopes, invalid JSON, unsupported body formats, and oversized
bodies return `400`; unexpected failures return a generic `500`. `/health`
still returns `{"status":"healthy"}`.

**Local foundation, not a public deployment yet:** a successful GET handshake
does not authenticate subsequent POST requests. Signature checking
(`X-Hub-Signature-256`) is not implemented in this phase. Before accepting real
traffic, add signature verification and HTTPS. Logs deliberately omit message
text, contact profiles, unknown payload fields, query strings, and request headers;
phone numbers are still personal data and require appropriate log controls.

Read [Chapter 2](docs/02-webhook-foundation.md) for the validation contract,
request flow, and explanation of every new component.

## Environment variables

Defined in [`.env.example`](.env.example). Copy it to `.env`; never commit `.env`.

| Variable                   | Used from | Purpose                                                   |
| -------------------------- | --------- | --------------------------------------------------------- |
| `PORT`                     | Stage 1   | HTTP port (default `3000`)                                |
| `LOG_LEVEL`                | Stage 1   | Pino log level (default `info`)                           |
| `DATABASE_URL`             | Stage 1   | PostgreSQL connection string, read by Prisma              |
| `REDIS_HOST`, `REDIS_PORT` | Later     | Redis location for BullMQ and caching                     |
| `AZURE_OPENAI_*`           | Later     | Endpoint, API key, and deployment name for AI replies     |
| `WHATSAPP_VERIFY_TOKEN`    | Phase 1   | Required non-empty token you choose for the GET handshake |
| `WHATSAPP_ACCESS_TOKEN`    | Later     | Token for calling the WhatsApp Cloud API                  |
| `WHATSAPP_PHONE_NUMBER_ID` | Later     | The WhatsApp business number that sends replies           |

## Project layout

```text
src/
├── server.ts          Starts the HTTP server; handles shutdown signals
├── app.ts             Builds the Express app (middleware + routes)
├── config/            Environment parsing and the shared logger
├── routes/            URL → handler wiring (/health and /webhook)
├── controllers/       Verification and inbound webhook handlers
├── services/          Application logic                (later stage)
├── repositories/      Database access via Prisma       (later stage)
├── providers/         Azure OpenAI and WhatsApp clients (later stage)
├── queues/            BullMQ queue definitions         (later stage)
├── workers/           Background job processors        (later stage)
├── middleware/        Centralized 400/500 responses (correlation IDs later)
├── shared/            Cross-cutting types, constants, utilities
└── generated/         Prisma client output (generated; not committed)
prisma/                Database schema and, later, migrations
docs/                  Learning guide, one chapter per stage
```

## Implementation phases

| Phase                        | Focus                                                                                  | Status  |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------- |
| Bootstrap (previous Stage 1) | Tooling, Express, logging, Prisma, Docker Compose                                      | ✅ Done |
| 1                            | Webhook ownership verification, payload validation, metadata logging, 400/500 handling | ✅ Done |
| Future                       | POST signature verification and correlation IDs                                        | Planned |
| Future                       | Data model, migrations, and repositories                                               | Planned |
| Future                       | Durable ingestion, BullMQ, and separate workers                                        | Planned |
| Future                       | AI provider, conversation cache, outbound placeholder, and end-to-end flow             | Planned |

The current phase follows the user's phase numbering; the original bootstrap
remains Chapter 1 in the learning guide. Future implementation order will be
decided stage by stage.

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
