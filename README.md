# liteBot

A backend for a **WhatsApp AI assistant**, built as a learning project. It starts as a
small proof of concept, but is organised so it can grow into a distributed,
multi-region system without a rewrite.

> **Current status: Phase 3 — Persistence Layer.** `GET /webhook` verifies
> ownership. `POST /webhook` validates events, saves each supported text message
> (with its sender and conversation) in PostgreSQL, puts a job for it on a BullMQ
> queue in Redis, then acknowledges. A separate worker process takes the jobs and
> logs them. There is no AI or reply sending yet. See
> [Persistence Layer](#persistence-layer),
> [Asynchronous Processing](#asynchronous-processing), and
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

This is the target architecture, not the current request path. Phases 2 and 3
implement the Webhook API → PostgreSQL → BullMQ → Worker part, with a worker
that only logs. Loading history in the worker, Azure OpenAI, and WhatsApp sending
are future work.

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
call, while AI responses can take seconds. The API records the work and answers;
the slow work happens elsewhere. The two can then be scaled independently.

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
and Docker Desktop (or another Docker engine). The Node minimum matches ESLint's
supported Node versions. Since Phase 3, both PostgreSQL and Redis must be running
for the webhook to accept text messages.

For step 3 below, follow [Generate your verification token](#generate-your-verification-token)
for the exact command and `.env` instructions.

```powershell
# 1. Install dependencies
npm ci

# 2. Create your local environment file only if it does not already exist
Copy-Item .env.example .env        # macOS/Linux: cp .env.example .env

# 3. Generate a private token and save it as WHATSAPP_VERIFY_TOKEN in .env.
#    An existing .env from the bootstrap stage needs this setting too.

# 4. Start PostgreSQL (durable data) and Redis (the queue) in the background
docker compose up -d --wait

# 5. Generate Prisma Client and create the database tables.
#    Repeat both after pulling a change that adds a migration.
npm run prisma:generate
npm run prisma:migrate:deploy

# 6. Run the API with auto-reload
npm run dev

# 7. In a second terminal, run the worker with auto-reload
npm run dev:worker
```

Check it works:

```powershell
curl http://localhost:3000/health
# {"status":"healthy"}
```

The API logs `HTTP server listening` and `Redis connection ready`; the worker logs
`Redis connection ready` and `Incoming message worker ready`. The API connects to
PostgreSQL only when the first message arrives, so a wrong `DATABASE_URL` shows up
as a `500` on that `POST`, not at startup.

Stop these services with `docker compose down` (add `-v` to delete their data,
including saved messages and any queued jobs). Their default ports are published only on
`127.0.0.1`; the example database credentials and unauthenticated Redis are for
local development, not deployment.

See the [dependency notes](docs/01-bootstrap.md#version-choices) for the agreed
version exceptions, BullMQ's transitive deprecation warning, and a deferred
development-only lint dependency advisory.

## Commands

| Command                         | What it does                                                         |
| ------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                   | Run the API (`src/server.ts`) with tsx, restarting on change         |
| `npm run dev:worker`            | Run the worker (`src/worker.ts`) with tsx, restarting on change      |
| `npm run build`                 | Generate Prisma Client, then compile `src/` to JavaScript in `dist/` |
| `npm start`                     | Run the compiled API from `dist/server.js`                           |
| `npm run start:worker`          | Run the compiled worker from `dist/worker.js`                        |
| `npm run typecheck`             | Type-check without writing files                                     |
| `npm test`                      | Startup, configuration, and webhook HTTP tests (no services needed)  |
| `npm run test:integration`      | Real BullMQ and PostgreSQL tests (needs local Redis and PostgreSQL)  |
| `npm run lint`                  | Run ESLint                                                           |
| `npm run format`                | Format all files with Prettier                                       |
| `npm run format:check`          | Report formatting problems without changing files                    |
| `npm run prisma:generate`       | Generate the Prisma client into `src/generated/`                     |
| `npm run prisma:migrate:deploy` | Apply committed migrations to the database in `DATABASE_URL`         |
| `npm run prisma:migrate`        | Development only: create and apply a migration after a schema change |

To run only the startup regression test:

```powershell
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
```

To run the webhook tests, or just the successful verification case:

```powershell
node --import tsx --test tests/webhook.test.ts
node --import tsx --test --test-name-pattern="verification echoes" tests/webhook.test.ts
```

`npm test` uses synthetic tokens, a fake persistence service, and an in-memory
queue, so it needs neither PostgreSQL nor Redis. `npm run test:integration`
connects to Redis on `127.0.0.1:6379` (override with `TEST_REDIS_PORT`) and to
PostgreSQL through `TEST_DATABASE_URL` (default: the Compose database on
`127.0.0.1:5432`); start both with `docker compose up -d --wait`. Each Redis test
uses its own random key prefix and deletes only its own keys. The PostgreSQL
tests create a throwaway `litebot_test_<random>` database, apply the migrations
to it, and drop it afterwards, so your development data is never touched. See
[Chapter 4, section 12](docs/04-persistence-layer.md#12-automated-tests).

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
notifications after subscription. Since Phase 2, POST validates the whole
envelope. Since Phase 3, it then saves each supported **text** message in
PostgreSQL (creating the sender's user and conversation if needed), puts a job
for each saved message on the `incoming-messages` queue in Redis, and returns
`200 OK` once both have succeeded. Other events (delivery statuses, images, and
so on) are logged as not queued, are not saved, and are still acknowledged with
`200`. A separate worker process consumes the queue; see
[Persistence Layer](#persistence-layer) and
[Asynchronous Processing](#asynchronous-processing).

```powershell
$payload = @'
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "local-business-account",
    "changes": [{
      "field": "messages",
      "value": {
        "messages": [{
          "id": "wamid.local-example",
          "from": "15550000001",
          "timestamp": "1767225600",
          "type": "text",
          "text": { "body": "Hello from a local test" }
        }]
      }
    }]
  }]
}
'@
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/webhook' -ContentType 'application/json' -Body $payload
# OK
```

This request now writes a user, a conversation, and a message to your
development database. [Chapter 4, section 11](docs/04-persistence-layer.md#11-run-it-yourself)
shows how to inspect those rows and delete them afterwards.

Malformed envelopes, invalid JSON, unsupported body formats, oversized bodies,
and text messages without a body or numeric timestamp return `400`. If
PostgreSQL cannot save the message, Redis cannot accept the jobs, or another
unexpected failure happens, the response is a generic `500` so Meta retries
later. `/health` still returns `{"status":"healthy"}` and checks neither
PostgreSQL nor Redis.

**Local foundation, not a public deployment yet:** a successful GET handshake
does not authenticate subsequent POST requests. Signature checking
(`X-Hub-Signature-256`) is not implemented yet, so anyone who can reach
`/webhook` can create database rows and queue jobs. Before accepting real
traffic, add signature verification and HTTPS. Logs deliberately omit message
text, contact profiles, unknown payload fields, query strings, and request
headers; phone numbers are still personal data and require appropriate log
controls. Phone numbers and message text are stored in PostgreSQL, and queued
jobs, including message text, are stored in Redis.

Read [Chapter 2](docs/02-webhook-foundation.md) for the validation contract and
[Chapter 3](docs/03-queue-infrastructure.md) for how messages become jobs.

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
Start PostgreSQL and Redis, then start or restart the API so it reads your saved
settings. If you have not created the tables yet, run step 5 of
[Local setup](#local-setup) (`npm run prisma:generate` and
`npm run prisma:migrate:deploy`) first:

```powershell
docker compose up -d --wait
npm run dev
```

Leave that terminal running. In a second terminal, start the worker so queued
messages are processed:

```powershell
npm run dev:worker
```

In a third terminal, confirm local connectivity:

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
`WhatsApp webhook payload received` and `WhatsApp webhook event received`.
Meta's `messages` sample is a text message, so the API saves it (logging
`User created`, `Conversation created`, and `Inbound message saved` the first
time), then logs `Incoming message queued` with a `jobId`, and returns `200 OK`.
The worker terminal then logs `Incoming message processing started` and
`Incoming message processing completed` with the same `correlationId`. If you
send the sample again and it carries the same message ID, the API logs
`Inbound message already saved` instead and the worker has nothing new to do.
**No WhatsApp reply is expected:** the worker only logs in this phase.

The dashboard sample proves that the callback path works. It does not prove
that a real phone number/account is correctly connected or subscribed. Real
message testing also requires the account/number setup under **API Setup**;
do that with authenticated delivery in a later phase, not with customer traffic
on this temporary receiver.

#### 6. End the test

Stop ngrok with Ctrl+C when finished; stop the local API and worker if you no
longer need them. Disconnect the temporary test subscription/callback if you are
done with it. If the public URL changes on a later session, update the Callback
URL and run **Verify and save** again. Meta cannot deliver while your server or
tunnel is stopped.

### Dashboard troubleshooting

| Symptom                                                           | Check                                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Verification times out or the tunnel returns 502                  | Both processes are running; ngrok targets the same port as `PORT`; the public hostname is current                                       |
| Verification returns 403                                          | The Verify token exactly matches `.env`; restart after changing it; do not use a WhatsApp access token                                  |
| Callback returns 404 or health JSON                               | The Callback URL must end in `/webhook`, not `/health` or just the host                                                                 |
| Opening `/webhook` directly in a browser returns 403              | Expected without Meta's verification query parameters; this alone does not mean the endpoint is broken                                  |
| Meta receives a login page or other HTML                          | It must reach the actual endpoint without interactive browser authentication or an intervening page                                     |
| Verification succeeds but there are no POST logs                  | Subscribe to **messages**, use that field's **Test**, and check the same app's callback configuration                                   |
| A sample POST returns 400                                         | Select the WhatsApp **messages** test, not another webhook object; the receiver validates the envelope                                  |
| A sample POST returns 500, log says `Can't reach database server` | PostgreSQL is not reachable: run `docker compose up -d --wait`; the API reconnects without a restart                                    |
| A sample POST returns 500, log shows Prisma error `P2021`         | The tables do not exist yet: run `npm run prisma:migrate:deploy`                                                                        |
| A sample POST returns 500 for another reason                      | Read the `err` in the API log. If Redis is not reachable, run `docker compose up -d --wait redis`; the API reconnects without a restart |
| The API logs `Incoming message queued`, worker silent             | Start the worker with `npm run dev:worker`; queued jobs wait in Redis until a worker runs                                               |
| POST succeeds but there is no WhatsApp reply                      | Expected for Phase 3; AI replies and sending are not implemented                                                                        |

Sources: [Meta callback configuration](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks),
[Meta dashboard sample tests](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot),
and [ngrok local webhook testing](https://ngrok.com/docs/share-localhost/webhooks).

## Asynchronous Processing

Phase 2 splits the work into two processes connected by a queue:

```text
WhatsApp
    |
Webhook        (API process: validate, save, enqueue, return 200)
    |
BullMQ         (the incoming-messages queue, stored in Redis)
    |
Worker         (separate process: takes jobs and processes them)
```

### Why the webhook should stay fast

Meta sends every notification as an HTTP POST and waits for the answer. If the
answer is not `200`, or delivery fails, Meta
[retries for up to 7 days](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#webhook-delivery-failure),
and retries can create duplicates. Future processing (database reads, Azure
OpenAI, sending the reply) can take seconds. Doing it before answering would
risk slow or failed deliveries, repeated messages, and a busy web server that
cannot accept new notifications. So the webhook only checks the request, records
the work as a **job**, and answers.

### Why a queue helps

| Benefit         | How the queue provides it                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Reliability** | Once Redis accepts a job, it waits there even if no worker is running or a worker crashes mid-job.                 |
| **Retries**     | If processing throws, BullMQ tries again: 3 attempts in total, with exponential backoff (~1 s, then ~2 s).         |
| **Scalability** | The API and the worker scale separately: add workers when processing is the bottleneck, API instances for traffic. |
| **Decoupling**  | The webhook only knows the job contract. Adding AI later changes the worker, not the webhook.                      |

### Running workers

The worker is a separate program with its own entrypoint, `src/worker.ts`:

```powershell
npm run dev:worker        # development, restarts on change
npm run build
npm run start:worker      # compiled, from dist/worker.js
```

It needs only Redis settings (`REDIS_HOST`, `REDIS_PORT`) and `LOG_LEVEL`, not
the HTTP port or verification token. It starts even if no messages arrive or
Redis is still starting, and it shuts down on Ctrl+C or `SIGTERM`. Each job
carries the request's `x-correlation-id`, so API and worker logs for one message
share the same `correlationId`. You can run several workers at once; BullMQ gives
each job to one of them. BullMQ does not start workers by itself: today you start
each one. Automatic startup and scaling are deferred; see
[the roadmap](#automatic-worker-startup-and-scaling-deferred).

The worker still only **logs** each job (with the message text redacted). It
does not read or write the database, call Azure OpenAI, or send WhatsApp
messages. Since Phase 3, PostgreSQL is the system of record and every job refers
to a message that is already saved there (see
[Persistence Layer](#persistence-layer)). Processing is still "at least once": a
message may occasionally be processed twice.
[Chapter 3](docs/03-queue-infrastructure.md) walks through the queue design,
hands-on experiments, retries, tests, and these limits in detail.

## Persistence Layer

Phase 3 makes PostgreSQL the **source of truth**. Before a message is queued, the
webhook saves it in the database:

```text
Webhook
    |
Persist Message
    |
Queue Job
    |
Worker
```

### Redis stores operational state; PostgreSQL stores durable state

| Store      | Kind of state | What it holds                                   | How long                                  |
| ---------- | ------------- | ----------------------------------------------- | ----------------------------------------- |
| Redis      | Operational   | Queued jobs, their status, retries              | Until processed and trimmed (latest 1000) |
| PostgreSQL | Durable       | Users, conversations, and every inbound message | Until we deliberately delete it           |

**Operational state** is work in progress ("this job is waiting", "this job failed
twice"): useful now, disposable later. **Durable state** is the facts the system
depends on ("this person sent this message in this conversation"): it must
survive restarts, crashes, and deployments.

### Why durable storage is needed even when queues exist

- **Jobs are temporary by design.** BullMQ keeps only the latest 1000 completed
  and failed jobs. A queue answers "what work is left?", not "what has this
  person said?", and the next phase's worker needs the conversation history.
- **Our Redis can lose recent writes.** It saves periodic snapshots. PostgreSQL
  records each change in its write-ahead log and flushes it to disk when the
  transaction commits.
- **Facts have relationships and rules.** Foreign keys tie messages to
  conversations and conversations to users; a unique constraint allows one user
  per phone number.
- **Duplicates must be recognized for good.** Meta can deliver a message more
  than once. Its WhatsApp message ID is stored with a unique constraint, so a
  redelivery is recognized next week as well as in the next second.
- **We can query and audit** the history with SQL.

The order is **save first, then queue**. If queuing fails after the save, the
request returns `500`, Meta retries, the saved message is recognized, and the job
is queued then. A job therefore never refers to a message the database has never
seen.

### What is stored

```text
users (id, phone_number unique, created_at, updated_at)
  └── conversations (id, user_id → users,
                     whatsapp_conversation_id unique nullable, category, origin_type,
                     expires_at, started_at, created_at, updated_at)
        └── messages (id, conversation_id → conversations,
                      whatsapp_message_id unique, direction INBOUND|OUTBOUND,
                      content, created_at)
```

For each supported text message, `POST /webhook` runs one transaction, locked per
sender so simultaneous messages from the same person cannot create two users or
two conversations:

1. Find the user by phone number; create the user if missing.
2. Find the user's latest conversation; create one if missing, with
   `started_at` set to the message's WhatsApp timestamp.
3. Save the inbound message.

It then enqueues a job whose BullMQ job ID is the saved message's database ID. A
redelivered message is saved once and queued once while its job is still kept in
Redis. The same WhatsApp message ID arriving from a **different** sender is
refused with a `500` and nothing is saved. Database code lives in repositories
(`src/repositories/`), behind interfaces, so the service and controller never use
Prisma directly.

The API and worker logs now include `userId`, `conversationId`, and `messageId`.
Since Phase 3, `messageId` is **our** database ID; Meta's ID is logged as
`whatsappMessageId`.

### WhatsApp conversations, not sessions

A `conversations` row represents a **WhatsApp conversation**, not a session the
application invents: no inactivity timeout or business rule ever starts a new
one. Its WhatsApp columns (`whatsapp_conversation_id`, `category`,
`origin_type`, `expires_at`) are filled in only when Meta reports them. Meta's
inbound message webhooks carry no conversation data; only status webhooks for
messages the business sends can, so these columns stay NULL until a later phase
processes those.

**AI memory is a separate concept.** The context the assistant remembers (recent
messages, summaries, facts) follows our own rules, so if it ever needs its own
state it will get its own table, such as `assistant_threads`, rather than
reusing `conversations`.
[Chapter 4](docs/04-persistence-layer.md#a-conversation-is-whatsapps-not-ours)
explains both, with Meta's documentation.

### Try it

To try it, follow [Local setup](#local-setup) (which now applies the migrations),
post the example payload from [GET versus POST](#get-versus-post), and query the
tables as shown in [Chapter 4](docs/04-persistence-layer.md#11-run-it-yourself).
Chapter 4 explains the data model, migrations, repositories, the transaction and
its lock, duplicate handling, and this phase's limits from first principles.

## Environment variables

Defined in [`.env.example`](.env.example). Copy it to `.env`; never commit `.env`.

| Variable                   | Used from | Purpose                                                                                        |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `PORT`                     | Stage 1   | API HTTP port (default `3000`)                                                                 |
| `LOG_LEVEL`                | Stage 1   | Pino log level for the API and worker (default `info`)                                         |
| `DATABASE_URL`             | Phase 3   | PostgreSQL connection string; required by the API and read by the Prisma CLI (not the worker)  |
| `REDIS_HOST`, `REDIS_PORT` | Phase 2   | Redis location for the BullMQ queue, used by the API and worker (defaults `localhost`, `6379`) |
| `AZURE_OPENAI_*`           | Later     | Endpoint, API key, and deployment name for AI replies                                          |
| `WHATSAPP_VERIFY_TOKEN`    | Phase 1   | Required non-empty token you choose for the GET handshake (API only)                           |
| `WHATSAPP_ACCESS_TOKEN`    | Later     | Token for calling the WhatsApp Cloud API                                                       |
| `WHATSAPP_PHONE_NUMBER_ID` | Later     | The WhatsApp business number that sends replies                                                |

`TEST_REDIS_PORT` (default `6379`) and `TEST_DATABASE_URL` (default: the Compose
database on `127.0.0.1:5432`, used only to create and drop throwaway test
databases) are read only by `npm run test:integration`.

## Project layout

```text
src/
├── server.ts          API entrypoint: Prisma, Redis, queue, HTTP server, shutdown
├── worker.ts          Worker entrypoint: Redis, BullMQ worker, shutdown
├── app.ts             Builds the Express app (middleware + routes)
├── config/            Environment parsing, the shared logger, Redis and Prisma connections
├── routes/            URL → handler wiring (/health and /webhook)
├── controllers/       Verification and inbound webhook handlers
├── domain/            Plain types for User, Conversation, Message, and domain errors
├── services/          Application logic: recording inbound messages
├── repositories/      Database access via Prisma, and the unit of work (transactions)
├── providers/         Azure OpenAI and WhatsApp clients (later stage)
├── queues/            The incoming-messages queue (producer side)
├── workers/           The incoming-message job processor (consumer side)
├── middleware/        Correlation IDs and centralized 400/500 responses
├── shared/            Cross-cutting types (incl. the job contract), constants, utilities
└── generated/         Prisma client output (generated; not committed)
prisma/                Database schema and migrations
tests/                 Unit/HTTP tests, and Redis and PostgreSQL integration tests
docs/                  Learning guide, one chapter per stage
```

## Implementation phases

| Phase                        | Focus                                                                                                                                  | Status   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Bootstrap (previous Stage 1) | Tooling, Express, logging, Prisma, Docker Compose                                                                                      | ✅ Done  |
| 1                            | Webhook ownership verification, payload validation, metadata logging, 400/500 handling                                                 | ✅ Done  |
| 2                            | BullMQ queue in Redis, separate logging worker, retries, correlation IDs                                                               | ✅ Done  |
| 3                            | PostgreSQL data model with WhatsApp conversation metadata, migrations, repositories, persisted inbound messages, duplicate recognition | ✅ Done  |
| Future                       | POST signature verification                                                                                                            | Planned  |
| Future                       | AI provider, conversation cache, outbound placeholder, and end-to-end worker flow                                                      | Planned  |
| Future                       | Idempotent processing and production durability (for example, a transactional outbox)                                                  | Planned  |
| After the end-to-end PoC     | Containerized API and worker, automatic restarts, queue-based worker autoscaling                                                       | Deferred |

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

### Automatic worker startup and scaling (deferred)

Today you start each worker yourself. BullMQ only shares jobs among workers that
are already running; it never starts processes. Making this automatic needs two
things outside BullMQ:

1. **Automatic start and restart:** run the API and worker as separate
   containers built from one image, with a
   [restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/).
2. **Autoscaling:** host workers on a platform that changes the number of copies
   with the queue backlog. For example, an
   [Azure Container Apps scale rule](https://learn.microsoft.com/en-us/azure/container-apps/scale-app),
   which uses [KEDA](https://keda.sh/docs/latest/scalers/redis-lists/), could
   watch the Redis list `bull:incoming-messages:wait`.

**We will revisit this once the proof of concept runs end to end.** Sensible
limits depend on real job durations, Azure OpenAI rate limits, and
per-conversation ordering, none of which exist yet.
[Chapter 3, section 13](docs/03-queue-infrastructure.md#13-who-starts-the-worker-automatic-scaling-is-deferred)
explains the idea and the questions to answer first.

## License

[MIT](LICENSE)
