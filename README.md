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

For step 3 below, follow [Generate your verification token](#generate-your-verification-token)
for the exact command and `.env` instructions.

```powershell
# 1. Install dependencies
npm ci

# 2. Create your local environment file only if it does not already exist
Copy-Item .env.example .env        # macOS/Linux: cp .env.example .env

# 3. Generate a private token and save it as WHATSAPP_VERIFY_TOKEN in .env.
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

### Generate your verification token

Generate it **on your own computer**, not on an online token-generator website.
In a PowerShell terminal, run:

```powershell
node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex') + '\n')"
```

This uses Node's built-in
[`crypto.randomBytes`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandombytessize-callback)
to generate 32 cryptographically random bytes, displayed as **64 hexadecimal
characters** (`0`-`9` and `a`-`f`). No additional package is needed.
The command only prints the value; it does not edit `.env` or configure Meta.
The 64-character length is a recommendation, not a length enforced by our app.

1. Copy the entire output line. Open your existing `.env` in the project root
   and replace the value on its `WHATSAPP_VERIFY_TOKEN=` line. Do not add a
   second copy of that setting or overwrite your other settings:

   ```dotenv
   WHATSAPP_VERIFY_TOKEN=PASTE_THE_64_CHARACTER_OUTPUT_HERE
   ```

2. Replace that placeholder with the generated value, with no surrounding
   spaces or quotes, and save `.env`. If the server is running, stop it with
   Ctrl+C, then run `npm run dev` again so it reads the new value.
3. When [configuring the callback in Meta](#connect-to-the-meta-dashboard), paste
   **the same generated value** into **Verify token**. Paste only the value,
   not the `WHATSAPP_VERIFY_TOKEN=` prefix. Do not generate another value for
   this field. Click **Verify and save** with your server and tunnel running.

Generate once and reuse that value across server restarts. It is not a WhatsApp
access token, ngrok authtoken, Meta app secret, or `hub.challenge`.
Keep it in your private `.env`; do not commit it, put it in `.env.example`, or
share it in chat, screenshots, or terminal transcripts.

If it is exposed or you need to replace it, generate a new value, update `.env`,
restart the server, update Meta's **Verify token**, and **Verify and save** again.
Changing only one side causes verification to fail with `403`.
This token verifies the GET handshake; it does not authenticate POST events.

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

To check the handshake locally, keep the generated token in `.env` and start
the server. In a second terminal, run the following and paste only the token
value when prompted. This does not change your token or contact Meta:

```powershell
$verifyToken = Read-Host 'Paste the WHATSAPP_VERIFY_TOKEN value from your .env'
$encodedToken = [uri]::EscapeDataString($verifyToken)
Invoke-RestMethod "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=$encodedToken&hub.challenge=123456"
# 123456
Remove-Variable verifyToken, encodedToken
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

### Does the webhook have to be hosted?

Meta needs a **publicly reachable HTTPS URL**, but the code does not need to be
deployed to a cloud host while you are developing. A tunnel can forward a public
HTTPS address to the server running on your computer:

```text
Meta -> https://<your-tunnel-host>/webhook -> tunnel -> http://localhost:3000/webhook
```

`localhost` means the computer making the request. Meta cannot use your
`http://localhost:3000/webhook` address to reach your laptop. A tunnel solves that
networking problem; it does not add webhook authentication.

For production, use a stable, always-on HTTPS endpoint (for example on Azure App
Service or Azure Container Apps) after implementing signature verification and
the other production safeguards. A laptop and temporary tunnel are not that setup.

### Connect to the Meta dashboard

**Testing boundary:** the current receiver does not verify POST signatures.
The following is a short, controlled exercise using a development app/test
resources and Meta's sample event, not real customer traffic. While a tunnel is
open, anyone who reaches its URL can send fake events. If your app is already
connected to production accounts, do not point it at this receiver. Stop the
tunnel after the exercise.

#### 1. Prepare the Meta app

Open [Meta for Developers - My Apps](https://developers.facebook.com/apps).
Use your development app with the **Connect with customers through WhatsApp**
use case. If you do not have one, follow
[Meta's getting-started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
to register as a developer, create the app, and complete its business-portfolio
setup. This is the developer **App Dashboard**, not just WhatsApp Manager.

Use the app's test setup. You do not need to publish the app to Live mode merely
to use the dashboard's `messages` sample test.

#### 2. Start this project locally

Complete [Local setup](#local-setup) first if you have not installed the
dependencies and created `.env`.

Follow [Generate your verification token](#generate-your-verification-token)
to create and save the value in `.env`. If you already did that, reuse the
existing value; do not generate a different one for the dashboard.
The following examples use the default `PORT=3000`.
Start or restart the server so it reads your saved settings:

```powershell
npm run dev
```

Leave that terminal running. In another terminal, confirm local connectivity:

```powershell
Invoke-RestMethod 'http://localhost:3000/health'
# status: healthy
```

#### 3. Give Meta a public HTTPS address

One development option is [ngrok](https://ngrok.com/docs/share-localhost/webhooks).
Create an ngrok account and install its agent using the
[official download instructions](https://ngrok.com/download). These are external
development tools, not dependencies added to this repository.

Copy your **ngrok authtoken** from your own ngrok dashboard and configure it
locally, replacing the placeholder below:

```powershell
ngrok config add-authtoken "YOUR_NGROK_AUTHTOKEN"
ngrok http 3000
```

The ngrok authtoken is **not** `WHATSAPP_VERIFY_TOKEN`, and neither is the Meta
WhatsApp access token. Do not put an ngrok token into Meta's Verify token field.

Use the same port as `PORT` if you changed it from 3000. Copy the **HTTPS
forwarding URL** printed by ngrok and append `/webhook`. Leave both ngrok and
the Node server running.

The tunnel provider and its traffic inspector may see raw URLs, headers, and
payloads, even though our Pino logs omit sensitive fields. Treat those inspection
logs as private; use only the isolated test setup here.

#### 4. Set the callback URL and verification token

In the Meta App Dashboard, open your app, then navigate to
**Use cases -> Connect with customers through WhatsApp -> Customize ->
Configuration**. In the older dashboard layout, use
**WhatsApp -> Configuration**. Find the **Webhooks** section and its
callback configuration/edit control.

| Dashboard field  | What to enter                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Callback URL** | The actual HTTPS tunnel URL followed by `/webhook`, for example `https://<your-tunnel-host>/webhook` |
| **Verify token** | The exact value of `WHATSAPP_VERIFY_TOKEN` in your `.env`                                            |

Do not use `/health`, `localhost`, or the domain alone. Do not append the
`hub.*` query parameters yourself; Meta adds them during verification.

Click **Verify and save**. Meta calls GET, our server echoes its challenge, and
the dashboard should save the callback. Your server terminal should contain
`Webhook verification succeeded`.

#### 5. Subscribe to `messages` and send a sample event

Saving the callback and subscribing to a field are separate steps. In the
webhook fields list, find **messages** and enable its **Subscribe** control.
Then use the **Test** link for that field and send its sample notification.
Meta documents this sample test as available in both Development and Live modes.

Watch the terminal running `npm run dev`. A successful POST produces
`WhatsApp webhook payload received` and `WhatsApp webhook event received`,
with the modeled metadata when present, and returns `200 OK`.
**No WhatsApp reply is expected:** this phase only logs and acknowledges.

The dashboard sample proves that the callback path works. It does not prove
that a real phone number/account is correctly connected or subscribed. Real
message testing also requires the account/number setup under **API Setup**;
do that with authenticated delivery in a later phase, not with customer traffic
on this temporary receiver.

#### 6. End the test

Stop ngrok with Ctrl+C when finished; stop the local server if you no longer
need it. Disconnect the temporary test subscription/callback if you are done
with it. If the public URL changes on a later session, update the Callback URL
and run **Verify and save** again. Meta cannot deliver while your server or
tunnel is stopped.

### Dashboard troubleshooting

| Symptom                                              | Check                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Verification times out or the tunnel returns 502     | Both processes are running; ngrok targets the same port as `PORT`; the public hostname is current      |
| Verification returns 403                             | The Verify token exactly matches `.env`; restart after changing it; do not use a WhatsApp access token |
| Callback returns 404 or health JSON                  | The Callback URL must end in `/webhook`, not `/health` or just the host                                |
| Opening `/webhook` directly in a browser returns 403 | Expected without Meta's verification query parameters; this alone does not mean the endpoint is broken |
| Meta receives a login page or other HTML             | It must reach the actual endpoint without interactive browser authentication or an intervening page    |
| Verification succeeds but there are no POST logs     | Subscribe to **messages**, use that field's **Test**, and check the same app's callback configuration  |
| A sample POST returns 400                            | Select the WhatsApp **messages** test, not another webhook object; the receiver validates the envelope |
| POST succeeds but there is no WhatsApp reply         | Expected for Phase 1; sending and business logic are not implemented                                   |

Sources: [Meta callback configuration](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks),
[Meta dashboard sample tests](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot),
and [ngrok local webhook testing](https://ngrok.com/docs/share-localhost/webhooks).

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
