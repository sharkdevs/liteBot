# Chapter 3 - Phase 2: Queue Infrastructure

Chapter 2 built a webhook that receives, validates, logs, and acknowledges
Meta's notifications. This phase adds the first step of **asynchronous
processing**: the webhook now hands each supported text message to a queue,
and a separate **worker** process picks it up later.

```text
WhatsApp
    |
Webhook (Express API process)
    |
BullMQ queue (stored in Redis)
    |
Worker (separate Node.js process)
```

The worker only **logs** what it receives in this phase. It does not build a
reply, call Azure OpenAI, write to PostgreSQL, or send a WhatsApp message.
The goal is to understand the event-driven shape before real work is added.

By the end of this chapter you should understand:

1. Why a webhook should stay fast, and what a queue gives us.
2. What Redis, BullMQ, a job, a producer, and a worker are.
3. Exactly which incoming messages become jobs and which do not.
4. How a request's correlation ID follows a message into another process.
5. How retries with exponential backoff work, and what happens after the last one.
6. How to run the API and worker, watch a job wait, and watch it complete.
7. What this phase deliberately does **not** guarantee yet.
8. Who starts workers today, and how automatic scaling could work later.

---

## 1. Why the webhook must stay fast

Meta delivers each notification as an HTTP `POST`. If our server does not
answer `200`, or the webhook cannot be delivered for another reason, Meta
[retries the delivery](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#webhook-delivery-failure)
with decreasing frequency for up to 7 days. Meta notes that these retries can
produce duplicate notifications.

Our future "real" work is slow:

- loading conversation history from PostgreSQL,
- calling Azure OpenAI, which can take several seconds,
- calling the WhatsApp Cloud API to send the reply.

If the webhook did all of that before responding, a slow AI response could
make Meta's request time out. Meta would then send the same message again, and
we could produce duplicate replies. A traffic spike would also tie up the web
server, which must keep accepting new notifications.

So the webhook does only the minimum: check the request, record the work in a
queue, and answer. Everything slow happens somewhere else.

## 2. What a queue gives us

A **queue** is a waiting list of work. One side adds items (the **producer**);
another side takes them out and processes them (the **consumer**, here called
a **worker**). Each item of work is called a **job**.

| Benefit         | What it means here                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reliability** | Once Redis accepts a job, it waits there even if no worker is running, or if a worker crashes. A restarted worker picks it up.                                            |
| **Retries**     | If processing throws an error, BullMQ schedules another attempt automatically. A temporary AI or network failure will not silently lose the message.                      |
| **Scalability** | The API and the worker are separate processes. You can run one API and five workers, or the reverse, depending on where the load is.                                      |
| **Decoupling**  | The webhook does not know what processing involves. Adding AI calls later changes the worker only; the webhook's contract (validate, enqueue, return 200) stays the same. |

The trade-off is that the system now has another moving part (Redis) and work
happens _after_ the HTTP response. Section 12 lists what that means for
guarantees.

## 3. The new tools

### Redis

[Redis](https://redis.io/docs/latest/) is an in-memory data store: it keeps
data in RAM, so reads and writes are very fast. It can also save snapshots to
disk. We have run Redis in Docker Compose since the bootstrap stage; this is
the first phase that actually connects to it.

### BullMQ

[BullMQ](https://docs.bullmq.io/) is a Node.js job-queue library that stores
its queues in Redis. It gives us:

- a `Queue` class for **adding** jobs (the producer side),
- a `Worker` class for **processing** jobs (the consumer side),
- automatic retries, backoff delays, job states, and events.

BullMQ stores each queue as a group of Redis keys whose names start with
`bull:<queue-name>:`. You do not need to read them directly, but section 10
shows a few safe commands for observing them.

### Two Redis clients, one adapter

The project already depended on the official `redis` (node-redis) package.
BullMQ 6 can use node-redis through its `createNodeRedisClient` adapter, so this
phase adds **no new dependencies**. (Older BullMQ examples use a different
client, `ioredis`; we did not need to install it.)

## 4. Following one message end to end

```text
Meta POST /webhook
   |
   | pino-http assigns x-correlation-id (section 7)
   v
express.json() parses the body
   |
   v
parseWebhookPayload() validates the whole batch      --> 400 if malformed
   |
   v
WebhookController builds one IncomingMessageJob per
supported text message; logs and skips the rest
   |
   v
IncomingMessageQueue.enqueue(jobs) --> Redis          --> 500 if Redis does not accept
   |
   v
200 OK  (the API's part ends here)

            ...later, possibly in another process or machine...

Worker takes the job from Redis
   |
   v
logs "processing started", the redacted payload, then "processing completed"
   |
   on error --> BullMQ schedules a retry (up to 3 attempts in total)
```

The API waits for Redis to **accept** the job, not for the worker to finish
it. That is the key difference from doing the work inline: the response time no
longer depends on how long processing takes.

## 5. Which messages become jobs

Meta's `messages` webhook carries many kinds of events: text, images,
reactions, delivery statuses, and more. Only one kind is queued in this phase.

### A supported text message

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "local-business-account",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messages": [
              {
                "id": "wamid.local-example",
                "from": "15550000001",
                "timestamp": "1767225600",
                "type": "text",
                "text": { "body": "Hello from a local test" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

A message is queued only when **all** of these are true:

- the change's `field` is `messages`,
- the message's `type` is `text`,
- it has a sender phone number (`from`),
- it has a text body and a timestamp (the validator guarantees these for text).

### How Meta's fields map to a job

| Meta message field | `IncomingMessageJob` field | Notes                                                        |
| ------------------ | -------------------------- | ------------------------------------------------------------ |
| `from`             | `phoneNumber`              | The sender's number, not our business number                 |
| `id`               | `messageId`                | Meta's message ID (`wamid...`)                               |
| `text.body`        | `messageText`              | The user's words; stored in Redis, **redacted in logs**      |
| `timestamp`        | `timestamp`                | Kept exactly as Meta sent it: Unix time in **seconds**, text |
| _(request)_        | `correlationId`            | Added by us; see section 7                                   |

`timestamp` stays a string of seconds, such as `"1767225600"` (1 January 2026,
00:00 UTC). We do not convert it to milliseconds or an ISO date yet, so there
is no chance of silently changing its meaning.

### New validation rules

Phase 1's envelope validation still applies. Phase 2 adds three rules, checked
for the **whole batch** before anything is logged as accepted or queued:

- If a message has `type`, it must be a non-empty string.
- If `type` is `text`, `text.body` must be a string that is not empty or only
  whitespace.
- If `type` is `text`, `timestamp` must be a string containing only digits.

Breaking any rule returns `400 Malformed request`. Because the whole batch is
checked first, an invalid second message means **no** job is created for the
valid first one.

### Events that are acknowledged but not queued

These return `200 OK` and create no job. Each skipped message logs
`Webhook message not queued` with a `reason`:

| Situation                                                    | Result                             |
| ------------------------------------------------------------ | ---------------------------------- |
| Delivery status update (`statuses`, no `messages`)           | Logged as an event; no job         |
| Image, audio, reaction, or other non-text type, or no `type` | `reason: unsupported_message_type` |
| Text message without a `from` number                         | `reason: missing_phone_number`     |
| A message under a change field other than `messages`         | `reason: unsupported_event`        |

Why acknowledge instead of rejecting? Meta sent a valid notification. A `4xx`
or `5xx` would make Meta retry something we will never be able to handle,
and it is not Meta's fault that we do not support images yet. We also never
invent a missing phone number, text, or timestamp.

## 6. The job contract and the queue "port"

[`incoming-message-job.ts`](../src/shared/types/incoming-message-job.ts)
defines what travels through the queue:

```ts
interface IncomingMessageJob {
  phoneNumber: string;
  messageId: string;
  messageText: string;
  timestamp: string;
  correlationId: string;
}

interface IncomingMessageQueuePort {
  enqueue(messages: IncomingMessageJob[]): Promise<void>;
}
```

The four requested fields describe the message. `correlationId` is a fifth,
deliberate field: the worker runs in another process and cannot see the
original HTTP request, so the ID has to travel inside the job (section 7).

`IncomingMessageQueuePort` is a **port**: a small interface that says what the
controller needs ("put these jobs somewhere") without saying how. The
controller depends on this interface, not on BullMQ.

- In production, `server.ts` injects `IncomingMessageQueue`, the BullMQ version.
- In the HTTP unit tests, a simple in-memory array is injected instead, so those
  tests need no Redis.
- If we later replace BullMQ with Kafka or Azure Event Hubs (see the
  [scalability roadmap](../README.md#scalability-roadmap)), only a new class
  implementing this interface is needed; the controller does not change.

This is the **dependency inversion** principle (the "D" in SOLID): high-level
code depends on an abstraction, and the infrastructure detail plugs into it.

## 7. Correlation IDs: one ID across two processes

A **correlation ID** is a label shared by every log line that belongs to the
same piece of work. With it you can search the logs for one value and see the
complete story of a message, even across processes.

[`request-id.middleware.ts`](../src/middleware/request-id.middleware.ts) runs
inside pino-http for every request:

1. If the caller sent an `x-correlation-id` header containing 1-128 characters
   from `A-Z a-z 0-9 . _ -`, that value is reused.
2. Otherwise (missing, too long, or unusual characters) a new random UUID is
   generated. Rejecting unusual values keeps attacker-chosen text such as line
   breaks out of our logs.
3. The ID is returned in the response's `x-correlation-id` header.

The ID then appears as `correlationId` in the HTTP request logs, the webhook
logs, error-middleware logs, the job's data, and every worker log for that job.
A real run from section 10, trimmed to the interesting fields:

```text
API     WhatsApp webhook payload received     correlationId=local-demo-1
API     WhatsApp webhook event received       correlationId=local-demo-1  messageId=wamid.local-example
API     Incoming message queued               correlationId=local-demo-1  jobId=1
API     request completed                     correlationId=local-demo-1
Worker  Incoming message processing started   correlationId=local-demo-1  jobId=1  attempt=1
Worker  Incoming message payload received     correlationId=local-demo-1  jobId=1
Worker  Incoming message processing completed correlationId=local-demo-1  jobId=1
```

The target requirements also mention `userId` and `conversationId`. Those do not
exist until the database phase creates users and conversations, so they are not
logged yet.

**One change from Chapter 2's logs.** Phase 1 logged a sanitized copy of the
whole batch in `WhatsApp webhook payload received`. That copy repeated the phone
numbers and message IDs that the per-message `WhatsApp webhook event received`
lines already contain. Phase 2 shrinks the receipt line to
`eventType: "webhook_received"` and `entryCount` (how many `entry` items the
request had) plus the correlation ID. The per-message lines are unchanged.

## 8. The new code, file by file

### `src/config/redis.ts` - creating a connection

`createRedisConnection(settings, logger, role)` builds a node-redis client,
wraps it with BullMQ's adapter, and logs its `ready`, `reconnecting`, and
`error` events. The adapter starts connecting immediately.

There is no global connection: each entrypoint creates its own and is
responsible for closing it. The `role` changes how the client behaves when
Redis is unavailable:

| Setting                | `producer` (API)                     | `worker`                                       |
| ---------------------- | ------------------------------------ | ---------------------------------------------- |
| Connect timeout        | 2 s                                  | 2 s                                            |
| Commands while offline | Fail immediately (offline queue off) | Wait for reconnection                          |
| Per-command timeout    | 2 s                                  | None                                           |
| Why                    | A webhook must answer quickly        | Workers wait for jobs with long-blocking reads |

A worker uses "blocking" Redis commands, which intentionally wait until a job
arrives. A short command timeout would break that, so only the producer has one.

### `src/queues/queue.constants.ts`

Names and numbers in one place, so the producer and worker cannot disagree:

| Constant                      | Value               | Meaning                                |
| ----------------------------- | ------------------- | -------------------------------------- |
| `INCOMING_MESSAGE_QUEUE_NAME` | `incoming-messages` | The queue both sides use               |
| `INCOMING_MESSAGE_JOB_NAME`   | `incoming-message`  | The name given to each job             |
| `MESSAGE_JOB_ATTEMPTS`        | `3`                 | Total attempts, including the first    |
| `MESSAGE_JOB_BACKOFF_MS`      | `1000`              | Starting delay for exponential backoff |
| `QUEUE_ADD_TIMEOUT_MS`        | `2000`              | Longest the webhook waits for Redis    |

### `src/queues/message.queue.ts` - the producer

`IncomingMessageQueue` implements the port and wraps a typed BullMQ `Queue`.

- **Readiness check.** If the Redis connection is not `ready`, `enqueue` throws
  immediately. The error middleware returns a generic `500`, so Meta knows to
  retry rather than believing we accepted the message.
- **One job at a time, in order.** Each message is added with BullMQ's
  `queue.add`, waiting for Redis to accept it before adding the next. This keeps
  the jobs in the same order as the messages in Meta's request.
- **A deadline.** If Redis has not accepted every job within 2 seconds, `enqueue`
  stops starting new adds and the request becomes a `500` rather than hanging.
- **Default job options**: 3 attempts, exponential backoff starting at 1 second,
  and keep at most the latest 1000 completed and 1000 failed jobs so Redis does
  not grow forever.
- **A log per accepted job**: `Incoming message queued` with `correlationId`,
  `jobId`, `phoneNumber`, and `messageId`.

BullMQ assigns job IDs (`1`, `2`, ...). We do not use Meta's message ID as the
job ID yet; see section 12.

#### A bug we found: why not `addBulk`?

BullMQ also has `addBulk`, which adds a list of jobs in one call. The first
version of this phase used it, and every automated test passed. Then a manual
experiment stopped and restarted Redis while the API kept running. After the
restart the API logged `Redis connection ready`, yet **every** text POST still
returned `500` until the API itself was restarted.

The cause was inside BullMQ 6.7.6's adapter for our Redis client:

1. BullMQ performs its queue operations with small **Lua scripts** that run
   inside Redis. To avoid sending the whole script every time, it loads each
   script once and afterwards refers to it by a fingerprint (`EVALSHA`).
2. Redis keeps loaded scripts only in memory. A restart forgets them, and a
   fingerprint for an unknown script fails with `NOSCRIPT`.
3. For a single command, the adapter catches `NOSCRIPT` and resends the full
   script (`EVAL`), which also reloads it. `addBulk` instead sends its commands
   as one transaction, and that path has no such fallback, so it failed forever.

Adding jobs one at a time uses the single-command path, which recovers on its
own. A regression test reproduces the restart by clearing Redis's script cache
with `SCRIPT FLUSH`, which removes no data, and checks the next enqueue succeeds.
It failed with the same `NOSCRIPT` error before the fix.

The lesson: tests that only run while everything is healthy cannot find
recovery bugs. Deliberately breaking a dependency is part of verifying it.

### `src/workers/message.worker.ts` - the consumer

`createMessageWorker(connection, logger)` returns a BullMQ `Worker` for
`incoming-messages`. For each job, its processor function:

1. logs `Retrying incoming message` as a warning if this is not the first attempt,
2. logs `Incoming message processing started` with the attempt number,
3. logs `Incoming message payload received` with all job fields, except that
   `messageText` is replaced with `"[Redacted]"`.

It also listens to BullMQ events:

| Event       | Log                                         | When                                      |
| ----------- | ------------------------------------------- | ----------------------------------------- |
| `ready`     | `Incoming message worker ready`             | The worker has connected to Redis         |
| `completed` | `Incoming message processing completed`     | The processor finished without throwing   |
| `failed`    | `Incoming message job failed` (error level) | An attempt threw; includes `attemptsMade` |
| `error`     | `Incoming message worker error`             | A Redis or infrastructure problem         |

The `ready` log can appear just after the first job's logs if a job was already
waiting; both happen as soon as the connection is up.

There is no business logic. This file is where later phases will load history,
call the AI provider, save the reply, and call the WhatsApp provider.

### `src/server.ts` and `src/worker.ts` - two entrypoints

The API and worker are separate programs, each with its own `npm` script:

| Process | Development          | Compiled               | Creates                                 |
| ------- | -------------------- | ---------------------- | --------------------------------------- |
| API     | `npm run dev`        | `npm start`            | producer connection, queue, Express app |
| Worker  | `npm run dev:worker` | `npm run start:worker` | worker connection, BullMQ worker        |

Both start successfully even when no messages arrive, and even when Redis is not
running yet; they log connection errors and keep retrying. If Redis is down, the
API still serves `/health` and GET verification, but a supported text POST gets
`500`.

`/health` is a **liveness** check (is the process running?), not a
**readiness** check (can it do useful work?). It does not test Redis.

### `src/config/env.ts` - role-specific configuration

- `loadApiEnv()` needs `PORT`, `WHATSAPP_VERIFY_TOKEN`, `LOG_LEVEL`, and Redis.
- `loadWorkerEnv()` needs only `LOG_LEVEL` and Redis.

The worker has no HTTP port and never verifies webhooks, so it does not require
those settings. Giving each process only what it needs is the principle of
least privilege applied to configuration.

`REDIS_HOST` (default `localhost`) must not be blank, and `REDIS_PORT`
(default `6379`) must be a whole number from 1 to 65535.

### `src/shared/utils/shutdown.ts` - stopping cleanly

Both entrypoints use `registerShutdown`. On Ctrl+C (`SIGINT`) or `SIGTERM` it:

1. logs `Shutting down` once, even if the signal repeats,
2. runs that process's cleanup,
3. forces exit with code `1` if cleanup has not finished within 10 seconds.

Cleanup order matters. The API stops accepting HTTP requests, closes the BullMQ
queue, then disconnects Redis. The worker closes the BullMQ worker, then
disconnects Redis. Closing BullMQ first lets it finish using the connection
before the connection disappears.

**Shutting down a worker while Redis is unavailable.** A normal BullMQ
`worker.close()` waits for any active job to finish, and that wait needs Redis.
During testing we found that when Redis had never connected, the wait never
ended: shutdown hit the 10-second deadline and exited with code `1`.

The fix in [`worker.ts`](../src/worker.ts):

- If Redis is ready, use the normal graceful close, which waits for active jobs.
- If Redis is not ready, log
  `Redis is not ready; closing worker without waiting for active jobs`
  and call `worker.close(true)` (BullMQ's "force" option).

A job interrupted this way is not lost: its Redis lock expires, and BullMQ's
[stalled-job check](https://docs.bullmq.io/guide/jobs/stalled) moves it back to
the queue for another attempt. (A job that stalls more often than BullMQ's limit,
one stall by default, is marked failed instead.) A regression test
now starts a worker against an unused port, signals shutdown, and requires a
clean exit code `0`.

## 9. Retries and exponential backoff

If the processor throws, BullMQ does not drop the job. It waits, then tries
again. **Exponential backoff** means each wait is twice as long as the last.
That gives a temporary problem, such as a briefly unavailable API, time to
recover without hammering it.

With `attempts: 3` and a starting delay of 1000 ms:

```text
attempt 1 --fails--> wait ~1 s --> attempt 2 --fails--> wait ~2 s --> attempt 3
                                                                        |
                                                   succeeds --> completed
                                                   fails    --> failed (no more retries)
```

"Attempts" counts the first try, so `3` means **one try plus two retries**.

What you see in the logs for each failed attempt:

```text
error  Incoming message job failed       attemptsMade=1   (scheduled for retry)
warn   Retrying incoming message         attempt=2
error  Incoming message job failed       attemptsMade=2   (scheduled for retry)
warn   Retrying incoming message         attempt=3
error  Incoming message job failed       attemptsMade=3   (final: job is now "failed")
```

A job that fails all three attempts stays in Redis in the `failed` state,
among the latest 1000 failed jobs, so it can be inspected or retried manually
later. In this phase the processor only logs, so real failures are unlikely; the
integration tests force failures to prove the retry configuration works.

## 10. Run it yourself

You need Docker Desktop running and a `WHATSAPP_VERIFY_TOKEN` in `.env`
(see the [README](../README.md#generate-your-verification-token)).

**Terminal 1 - Redis and the API:**

```powershell
docker compose up -d --wait redis
npm run dev
```

Look for `HTTP server listening` and `Redis connection ready`.

### Experiment A: a job waits for a worker

Leave the worker stopped. In **terminal 2**, post a synthetic text message:

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
$response = Invoke-WebRequest -Method Post -Uri 'http://localhost:3000/webhook' `
  -ContentType 'application/json' -Headers @{ 'x-correlation-id' = 'local-demo-1' } -Body $payload
$response.StatusCode                    # 200
$response.Headers['x-correlation-id']   # local-demo-1
```

Terminal 1 logs `Incoming message queued` with a `jobId`. Now ask Redis how many
jobs are waiting:

```powershell
docker compose exec redis redis-cli LLEN bull:incoming-messages:wait
# (integer) 1     (or more if you have posted before)
```

The job is safely stored even though nothing is processing it.

### Experiment B: the worker processes it

In **terminal 3**, start the worker:

```powershell
npm run dev:worker
```

It logs `Incoming message processing started`,
`Incoming message payload received` (with `"messageText":"[Redacted]"`), and
`Incoming message processing completed`, all with `correlationId` `local-demo-1`.
Check Redis again:

```powershell
docker compose exec redis redis-cli LLEN bull:incoming-messages:wait
# (integer) 0
docker compose exec redis redis-cli ZRANGE bull:incoming-messages:completed 0 -1
# the job IDs that have completed, for example "1"
```

Post the payload again while the worker is running; it is processed within
moments. Change the `id` each time if you want to tell the runs apart in logs.

Avoid `HGETALL` or `MONITOR` on these keys while learning: they print the stored
job data, including the private message text, to your terminal.

### Experiment C: Redis is unavailable

```powershell
docker compose stop redis
```

Both processes log `Redis connection error` and keep retrying. `GET /health`
still returns `200` (liveness only). Re-running the POST now returns `500`,
because the API refuses to acknowledge work it could not queue. Press Ctrl+C in
the worker terminal: it logs the "closing worker without waiting" message and
exits cleanly. Bring Redis back with `docker compose up -d --wait redis`. The API
logs `Redis connection ready` and accepts the same POST again (`200`), without a
restart. Start the worker again and it processes the waiting job. A worker left
running during a Redis restart also reconnects and continues on its own.

### Compiled equivalents

```powershell
npm run build
npm start               # API from dist/server.js
npm run start:worker    # worker from dist/worker.js, in another terminal
```

## 11. Automated tests

| Command                    | Needs Redis? | What it covers                                                                     |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `npm test`                 | No           | Startup and shutdown, configuration, webhook HTTP behavior with an in-memory queue |
| `npm run test:integration` | Yes          | The real BullMQ queue and worker against a local Redis                             |

The integration tests connect to `127.0.0.1` on `TEST_REDIS_PORT` (default
`6379`), so `docker compose up -d --wait redis` is enough. Each test uses its own
random key prefix (`litebot-test-<uuid>`) and deletes only that prefix when it
finishes, so they never touch the real `incoming-messages` queue.

Integration tests (real Redis):

| Test                                                                    | Proves                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| HTTP acknowledges Redis acceptance before a worker consumes the message | The webhook answers without waiting for processing        |
| A disconnected producer returns 500 without acknowledging a job         | No false `200` when Redis cannot accept the job           |
| The producer keeps accepting messages after Redis loses its Lua scripts | The API recovers from a Redis restart (section 8)         |
| A message waits in Redis until a worker logs completion                 | Jobs survive having no worker; text never appears in logs |
| Failed processing retries twice with backoff and can complete           | Three attempts with ~1 s and ~2 s gaps                    |
| Three unsuccessful attempts leave a failed job without completion       | Exhausted jobs end in `failed`                            |

The script-cache test runs `SCRIPT FLUSH` on the local Redis. That clears only
Redis's in-memory script cache, never queue data, and this project's queue and
worker reload scripts automatically on their next command.

To force failures without adding a fake failure mode to production code, the
retry tests temporarily make the worker's payload log call throw.

Unit-level additions include: text messages across several entries carrying the
request's correlation ID; queue failure becoming `500`; an invalid later text
message preventing any enqueue; missing or non-numeric timestamps returning
`400`; statuses, images, and phone-less messages returning `200` without jobs;
supplied, missing, and unsafe correlation headers; worker configuration not
requiring the API token or port; and the worker-shutdown regression.

```powershell
npm test
npm run test:integration
node --import tsx --test --test-name-pattern="worker can shut down" tests/bootstrap.test.ts
npm run typecheck; npm run lint; npm run format:check; npm run build
```

## 12. Honest limits of this phase

A queue improves reliability, but it does not make a system perfect. These are
the current boundaries.

**Redis storage is not the database.** "No persistence" in this phase means no
PostgreSQL or business records. Jobs, including the message text, **are** stored
in Redis until they are removed by the retention limits.

**Redis can lose very recent jobs.** The Compose Redis keeps data in memory and
saves periodic snapshots to its volume; append-only logging (`appendonly`) is
off. A Redis crash can therefore lose jobs accepted since the last snapshot.
Production would need a durability configuration chosen deliberately. Our Redis
uses `noeviction`, which BullMQ requires, so Redis will not silently delete jobs
to free memory.

**A batch can be partly accepted.** Jobs are added one at a time. If Redis
fails on the second message of a batch, the first stays queued while the request
returns `500`. Likewise, the 2-second deadline stops waiting but cannot un-send a
command Redis may still complete. In both cases Meta retries the delivery, and
some messages may end up queued twice. (BullMQ's
[`addBulk`](https://docs.bullmq.io/guide/queues/adding-bulks) has the same
partial-failure caveat, so it would not avoid this either.)

**Duplicates are possible; exactly-once is not promised.** Meta can deliver the
same notification more than once, and a retried or interrupted job runs again.
The system is "at least once": a message should be processed, possibly more than
once. Later phases that send replies will need **idempotency** (for example,
using Meta's message ID to recognize work already done) before duplicates
matter. No deduplication exists yet.

**POSTs are still unauthenticated.** As in Chapter 2, anyone who can reach
`/webhook` can submit a valid-looking event, and now that event becomes a job.
Meta signature verification (`X-Hub-Signature-256`) is still required before
real traffic.

**Logs still contain phone numbers.** Message text is redacted, but phone
numbers and message IDs identify people. Use synthetic data until log access and
retention controls exist.

**Only text messages from known numbers are processed.** Everything else is
acknowledged and logged as not queued.

## 13. Who starts the worker? (Automatic scaling is deferred)

A common misunderstanding is that BullMQ starts workers. It does not. The work
is split like this:

| Who                         | Responsibility                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **You, today**              | Start the worker process with `npm run dev:worker` or `npm run start:worker`.                                      |
| **BullMQ, inside a worker** | Take jobs from Redis, call our processing function, record completion or failure, and schedule retries.            |
| **A future host platform**  | Start worker processes automatically, restart them if they crash, and change how many are running based on demand. |

One running worker handles many messages, one after another. BullMQ does not
start a new process for each message. If no worker is running, jobs simply wait
in Redis, as Experiment A in section 10 shows.

### Two ways to process more messages at once

- **Concurrency inside one worker.** BullMQ's `concurrency` option lets one
  worker handle several jobs at the same time while each waits on slow
  input/output, such as a future Azure OpenAI call. The default is 1, and we
  have not changed it.
- **More worker processes.** Run more copies of the worker, on the same machine
  or on different machines. BullMQ gives each job to only one of them.

BullMQ explains both options in
[Parallelism and Concurrency](https://docs.bullmq.io/guide/parallelism-and-concurrency).

### What "automatic" would mean

There are two separate capabilities, and neither comes from BullMQ:

| Capability                  | Meaning                                                                        | Example tool                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic start and restart | Workers run without anyone opening a terminal, and come back after a crash.    | [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)                                         |
| Autoscaling                 | The number of worker copies (**replicas**) goes up and down with the workload. | [Azure Container Apps scale rules](https://learn.microsoft.com/en-us/azure/container-apps/scale-app), built on [KEDA](https://keda.sh/docs/) |

A possible path for this project (an idea to evaluate, not a decision):

1. **Containerize.** Build one Docker image for the application, and run the API
   (`node dist/server.js`) and the worker (`node dist/worker.js`) as separate
   containers with a restart policy such as `unless-stopped`. Docker Compose
   can run a fixed number of workers, but it does not change that number by
   itself when the backlog grows.
2. **Deploy where autoscaling is built in.** Azure Container Apps fits the
   project's Azure direction. It uses KEDA (Kubernetes Event-driven
   Autoscaling) internally, so we would not run a Kubernetes cluster ourselves.
   A
   [Redis list scale rule](https://keda.sh/docs/latest/scalers/redis-lists/)
   could watch `bull:incoming-messages:wait`, the same list you counted in
   Experiment A. Example limits might be "at least 1 worker, at most 5, about 20
   waiting jobs per worker"; real numbers must come from measurements.

```text
Redis list bull:incoming-messages:wait   (how many jobs are waiting)
        |
        | checked periodically by the scale rule
        v
Azure Container Apps  -->  adds or removes worker replicas (min 1 ... max N)
        |
        v
worker 1    worker 2    worker 3 ...   (each runs node dist/worker.js;
                                        BullMQ gives each job to one of them)
```

### Questions to answer before turning it on

- **The waiting list is not the whole workload.** Jobs being processed are in
  BullMQ's `active` list, and retries waiting out their backoff are in
  `delayed`. A rule that watches only `wait` might remove workers that are still
  busy, so keep at least one worker and scale down conservatively.
- **Scaling down stops processes.** Our graceful shutdown (section 8) gives an
  active job up to 10 seconds to finish. A job interrupted after that comes
  back as a stalled job, or fails if it stalls too often. The platform must also
  allow enough time for a job to finish before it forcibly stops a replica.
- **More workers increase duplicate and ordering risks.** Two messages from the
  same person could be processed at the same time or out of order. Once replies
  depend on conversation history, we will need per-conversation ordering and
  the idempotency discussed in section 12.
- **More workers mean more AI calls.** Scaling out can exceed Azure OpenAI rate
  limits, so we may need a replica cap or BullMQ's rate limiter.
- **Redis becomes even more important.** Every replica connects to it, so its
  durability, connection limits, authentication, and TLS (encrypted
  connections) matter. The local Compose Redis has no password and is only for
  development.

### Decision: revisit once the PoC runs end to end

We are **not** adding automatic startup or autoscaling now. The worker only
logs, so there is nothing meaningful to scale yet, and good limits depend on
measurements we do not have: how long a real job takes, how many messages
arrive, and the AI provider's limits.

**We will revisit automatic worker startup and scaling once the proof of concept
runs end to end:** webhook → queue → worker → database → Azure OpenAI → WhatsApp
provider placeholder. Then we will measure the real flow and choose the
platform, scale rule, replica limits, and worker concurrency.

## 14. What comes next

The pipeline exists, but the worker is a placeholder. Later phases will:

- add the `User`, `Conversation`, and `Message` models and repositories,
- persist inbound messages,
- give the worker real steps: load history, build a prompt, call the AI provider,
  save the reply, and call the WhatsApp provider placeholder,
- add a Redis-backed conversation cache,
- authenticate webhook deliveries and handle duplicates,
- after the end-to-end flow works, revisit automatic worker startup and scaling
  (section 13).

**Previous:** [Chapter 2 - Webhook Foundation (Phase 1)](02-webhook-foundation.md)

## Official references

- [BullMQ: connections and the node-redis adapter](https://docs.bullmq.io/guide/connections)
- [BullMQ: retrying failing jobs and backoff](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ: adding jobs in bulk](https://docs.bullmq.io/guide/queues/adding-bulks)
- [BullMQ: graceful worker shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown)
- [BullMQ: parallelism and concurrency](https://docs.bullmq.io/guide/parallelism-and-concurrency)
- [BullMQ: stalled jobs](https://docs.bullmq.io/guide/jobs/stalled)
- [BullMQ: going to production (persistence and eviction)](https://docs.bullmq.io/guide/going-to-production)
- [Redis: production usage with node-redis](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
- [Redis: persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Meta: WhatsApp webhooks overview and delivery retries](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#webhook-delivery-failure)
- [Redis: `SCRIPT FLUSH` and the script cache](https://redis.io/docs/latest/commands/script-flush/)
- [Docker: start containers automatically (restart policies)](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Azure Container Apps: scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)
- [KEDA: Redis lists scaler](https://keda.sh/docs/latest/scalers/redis-lists/)
