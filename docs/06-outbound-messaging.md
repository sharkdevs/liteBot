# Chapter 6 - Phase 5: Outbound WhatsApp Messaging

[Chapter 5](05-ai-integration.md) generated replies and saved them without sending.
This phase adds the transport half: a second queue and a dedicated WhatsApp worker.
The AI worker still never calls Meta.

## 1. Two producers, two consumers

A **producer** publishes a job; a **consumer** performs it later. The webhook
produces incoming work. The AI worker consumes that work and becomes the producer
of outgoing work:

```text
Incoming Queue
      |
      V
AI Worker          -> PostgreSQL: save OUTBOUND / PENDING
      |
      V
Outgoing Queue     (outgoing-messages)
      |
      V
WhatsApp Worker    -> PostgreSQL: record SENT or FAILED
      |
      V
WhatsApp Cloud API
```

Separating generation from sending lets each fail, retry, and scale independently.
If Meta is unavailable, the AI worker can keep generating replies and publishing
them; outgoing jobs wait or retry without calling the model again. This is
**decoupling**, not the removal of all dependencies: the AI worker still needs
PostgreSQL and Redis to save and publish its result.

There are now three manually started processes:

| Process         | Entrypoint               | Responsibilities                               | Additional settings          |
| --------------- | ------------------------ | ---------------------------------------------- | ---------------------------- |
| API             | `src/server.ts`          | Validate, persist inbound, queue               | Verify token, HTTP port      |
| AI worker       | `src/worker.ts`          | Load context, generate, save, publish outgoing | Azure AI settings            |
| WhatsApp worker | `src/whatsapp.worker.ts` | Send, record acceptance, handle failures       | WhatsApp sending credentials |

All three use Redis and PostgreSQL. Only the WhatsApp worker loads the sending
credentials. BullMQ does not start either worker for you; containers and
autoscaling remain a separate stage.

## 2. A provider contract, not vendor calls in business logic

`IWhatsAppProvider` lives in `src/providers/whatsapp/whatsapp-provider.ts`:

```typescript
interface IWhatsAppProvider {
  sendTextMessage(phoneNumber: string, message: string): Promise<WhatsAppSendResult>;
}

interface WhatsAppSendResult {
  readonly providerResponseId: string;
}
```

**Contract decision:** the phase prompt requested both `Promise<void>` and a
returned provider response/`providerResponseId` log. A void return cannot supply
that receipt to the caller. We return a small typed result instead, rather than
exposing Meta's entire response or using mutable "last response" state.

`WhatsAppCloudApiProvider` uses Node's built-in `fetch`; no new SDK is needed.
It posts to `https://graph.facebook.com/v26.0/{phone-number-id}/messages` with:

- The access token in the `Authorization: Bearer ...` header, never the URL.
- `messaging_product: "whatsapp"`, `recipient_type: "individual"`, the recipient,
  and `type: "text"`.
- `text.body` containing the reply; link previews are disabled.

The adapter checks the response shape and returns `messages[0].id`. It uses a
10-second timeout covering the request and response read, disallows redirects,
and does not retry internally. It rejects blank text, text longer than 4096
UTF-16 code units (a conservative limit for emoji), and invalid phone numbers.
It never silently truncates or splits the response.

Meta's text-message examples currently use v27.0, while its Graph API version
table lists v26.0 as the latest released version. This implementation deliberately
pins v26.0 from the release table; review that constant when upgrading.

## 3. Persist first, publish second

`AiResponseService` saves the reply before adding an `OutgoingMessageJob`:

| Field                     | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `phoneNumber`             | Recipient copied from the inbound sender                     |
| `conversationId`          | Existing conversation                                        |
| `messageId`               | **Outbound** database row ID, not the inbound row or Meta ID |
| `content`                 | Saved reply text (never logged)                              |
| `correlationId`, `userId` | Original request/user context for tracing                    |

`OutgoingMessageQueue` uses the saved outbound ID as BullMQ's `jobId`. Like the
incoming producer, it uses single `queue.add` calls, not `addBulk`, preserving
the node-redis adapter's recovery after Redis loses its Lua scripts.

The new nullable, unique `reply_to_message_id` points to the inbound row that
caused a reply. This handles a particularly important failure:

1. The AI reply commits to PostgreSQL.
2. Redis publication fails.
3. BullMQ retries the incoming job.
4. The service finds the saved reply and republishes the **same ID and content**,
   without another model call.

The repository upsert also prevents concurrent attempts from saving two replies
for one inbound message. A saved `SENT` or `FAILED` reply is not automatically
requeued by an incoming-job replay. Failed deliveries must be investigated
separately instead of being silently resent.

## 4. Message state and migration

The additive migration introduces the `message_status` enum and the reply link:

| Outbound state | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `PENDING`      | Saved, but no acceptance has been recorded; may be queued or retrying |
| `SENT`         | Meta accepted the API call and its message ID was saved               |
| `FAILED`       | Sending stopped after a permanent error or exhausted attempts         |

Inbound rows have `status = NULL`: they do not have an outbound delivery state.
The migration backfills old unsent Phase 4 replies to `PENDING`, without
inventing a reply link or automatically publishing them. Existing outbound rows
with a Meta ID become `SENT`. No messages are deleted.

On acceptance, the repository updates `status` and `whatsapp_message_id` in one
database operation. A replay of a `SENT` row skips the HTTP call. A late failure
cannot downgrade an already-recorded `SENT` state.

**Accepted is not delivered.** This phase does not process Meta's later
`delivered`, `read`, or `failed` status webhooks. A `SENT` row is not evidence
that the recipient received or read the reply. WhatsApp conversation metadata
also remains unchanged.

## 5. Retry policy and safe diagnostics

Outgoing jobs have `attempts: 3` and exponential backoff starting at 1000 ms
(about 1 second, then 2 seconds). The worker retries network/timeouts, HTTP
408/429/5xx, Meta's `is_transient` flag, and documented temporary/rate-limit
codes: `1`, `2`, `4`, `80007`, `130429`, `131000`, `131016`, `131056`.

Other API rejections, such as an expired token or a closed customer-service
window, are permanent for this job. The worker persists `FAILED` and throws
BullMQ's `UnrecoverableError` to stop futile retries. Transient errors keep the
row `PENDING` until the last attempt.

Terminal status writes are **awaited inside the processor**, not launched from
an asynchronous event listener that BullMQ would not await. The worker logs
success only after acceptance has been persisted.

Logs include `phoneNumber`, `messageId`, `conversationId`, `correlationId`,
`userId`, and, on acceptance or a sent-row replay, `providerResponseId`.
Failures log attempt number, terminal/retryable flags, HTTP status, and numeric
Meta error code. Raw provider bodies, exception causes, tokens, and content
are excluded from logs and BullMQ failure reasons.

Phone numbers are personal data: keep log access restricted and apply a
retention policy before production use.

## 6. Run safely

**POST signature verification is still missing. Do not expose this version to
real customer traffic or production.** An unauthenticated webhook could otherwise
trigger model usage and real sends. Existing local curl/dashboard examples use
synthetic senders; leave the WhatsApp worker stopped while running those examples.
No tests in this repository send live WhatsApp messages.

Stop API/AI processes before applying the migration, then:

```powershell
docker compose up -d --wait
npm run prisma:generate
npm run prisma:migrate:deploy
```

In the existing uncommitted `.env`, set `WHATSAPP_ACCESS_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID`. The latter is Meta's **numeric business phone number
ID**, not the sender's display number, WABA ID, or recipient's number. Use an
authorized token with the `whatsapp_business_messaging` permission. Do not paste
it into logs, issues, or commits.

Start the API and AI worker in separate terminals as before:

```powershell
npm run dev
# Separate terminal:
npm run dev:worker
```

Only when deliberately testing with your own isolated Meta test setup and
allowlisted recipient, start the third process:

```powershell
npm run dev:whatsapp
# Compiled alternative after npm run build:
npm run start:whatsapp
```

**Starting this process sends existing waiting outgoing jobs.** Inspect the
queue before starting it; do not use a production queue for synthetic tests.
Send an inbound message from your test recipient to the business number. Free-form
text replies require an open 24-hour customer-service window. Outside that
window Meta requires an approved template; templates are not implemented here.
We do not open tunnels, change your Meta app, or send messages automatically as
part of setup or verification.

Follow `Incoming message queued` -> `Outgoing message queued` ->
`WhatsApp message sent`. Copy the outgoing `messageId` and inspect locally:

```powershell
docker compose exec -T postgres psql -U litebot -d litebot -P pager=off -c "SELECT id, reply_to_message_id, direction, status, whatsapp_message_id, length(content) AS characters FROM messages WHERE id = 'PASTE_OUTBOUND_MESSAGE_ID';"
```

Use the database named by your own `DATABASE_URL` if it is not the Compose
database. `PENDING` with no outgoing job may indicate a publication failure.
`FAILED` requires checking the safe error codes, credentials, recipient, and
service window before deliberately retrying that existing outgoing job. A
manual BullMQ retry is a new operator decision and can send another message.

## 7. Reliability limits

This is **at-least-once**, not exactly-once delivery:

- PostgreSQL save and Redis publication are not one transaction. If publication
  exhausts incoming retries, the saved reply can remain `PENDING` without a job.
  Recovery uses the same reply ID, but there is no automatic outbox relay yet.
- If Meta accepts a message but the HTTP response is lost, or the database cannot
  record acceptance, a retry can send a duplicate. A `SENT` guard cannot protect
  an acknowledgement we never recorded. When the receipt is known but its save
  fails, `WhatsApp acceptance could not be persisted` logs its ID for investigation.
- If the final status write itself fails, the worker logs
  `Outgoing message FAILED status could not be persisted` and fails the queue job;
  PostgreSQL may remain `PENDING`. A worker crash or terminal stalled job can
  also leave state unreconciled. A durable reconciliation process is future work.
- Separate workers/replicas can reorder replies. There is no per-recipient
  ordering, adaptive rate limiter, or long-term retry scheduler yet.
- History still consists of stored messages, including pending/failed assistant
  replies; it is not a delivered-only transcript.

An eventual transactional outbox, receipt reconciliation, per-recipient ordering,
and authenticated webhooks are separate reliability/security stages. This phase
does not add caching, RAG, embeddings, business workflows, or automatic scaling.

## 8. Verification and references

Run `npm test`, then `npm run test:integration`, sequentially. Unit tests cover
configuration isolation, HTTP authentication and payloads, response parsing,
timeouts, retry classification, log privacy, and duplicate-send guards.
Integration tests use real Redis and a throwaway PostgreSQL database with fake
AI and fake Meta HTTP responses. They exercise the webhook -> AI -> outgoing
queue -> WhatsApp worker -> receipt path, transient recovery, exhausted retries,
permanent rejection, and migration over existing rows. They do not prove that
your live credentials or Meta account are configured correctly.

- [Meta text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages)
- [Meta error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
- [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ unrecoverable errors](https://docs.bullmq.io/patterns/stop-retrying-jobs)
- [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids)

**Previous:** [Chapter 5 - AI Integration](05-ai-integration.md)
