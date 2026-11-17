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
WhatsApp Worker    -> PostgreSQL: reserve UNKNOWN, then record SENT or FAILED
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
for one inbound message. Its conflict update writes back the same
`replyToMessageId`, leaving the first reply's content, status, and receipt intact.
This nonempty update uses PostgreSQL's atomic conflict handling: an empty Prisma
update can instead perform separate lookup/insert operations that race and fail
with `P2002`. The integration test holds inserts until four concurrent saves
overlap, then verifies that every caller receives the same reply.

A saved `SENT`, `FAILED`, or `UNKNOWN` reply is not automatically
requeued by an incoming-job replay. Failed deliveries must be investigated
separately instead of being silently resent.

The reply also stores `dispatch_correlation_id` in that same atomic write.
This is **dispatch intent**: evidence that authenticated work was authorized for
publication, plus the correlation context needed after a restart. The sender's
`OutgoingDispatchRelay` scans at most 100 pending intents per pass, every ten
seconds, using an ID cursor. It republishes with the saved message ID and resets
the cursor after reaching the end. Failed publication does not advance past the
failed row. A new process can recover a reply even if the AI producer crashed
immediately after the database commit, without another incoming job or AI call.

This is a pending-row reconciler rather than a separate outbox table. Repeated
publication is harmless while the stable BullMQ job exists; the durable send
claim protects the HTTP boundary if a job is later recreated. The relay starts
with the WhatsApp process after Redis becomes ready and stops before its
connections close. Recovery therefore requires that process to be running.

## 4. Message state and migration

The additive migration introduces the `message_status` enum and the reply link:

| Outbound state | Meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `PENDING`      | Saved, but no acceptance has been recorded; may be queued or retrying                    |
| `SENT`         | Meta accepted the API call and its message ID was saved                                  |
| `FAILED`       | Sending stopped after a permanent error or exhausted attempts                            |
| `UNKNOWN`      | An attempt was reserved, but acceptance is not durably known; never automatically resend |

Inbound rows have `status = NULL`: they do not have an outbound delivery state.
The migration backfills old unsent Phase 4 replies to `PENDING`, without
inventing a reply link or automatically publishing them. Existing outbound rows
with a Meta ID become `SENT`. No messages are deleted.

The follow-up `delivery_recovery` migration adds `UNKNOWN`, the nullable dispatch
marker, a partial index for pending intents, and the user's next permitted send
time. It deliberately does not backfill dispatch intent. Old unsigned incoming
jobs are refused before AI generation, and legacy replies cannot pass the send
claim. Replaying a signed request does not retroactively authorize an old reply.

On acceptance, the repository updates `status` and `whatsapp_message_id` in one
database operation. A replay of a `SENT` row skips the HTTP call. A late failure
cannot downgrade an already-recorded `SENT` or uncertain `UNKNOWN` state.

**Accepted is not delivered.** This phase does not process Meta's later
`delivered`, `read`, or `failed` status webhooks. A `SENT` row is not evidence
that the recipient received or read the reply. WhatsApp conversation metadata
also remains unchanged.

## 5. Retry policy and safe diagnostics

Outgoing jobs have `attempts: 3` and exponential backoff starting at 1000 ms
(about 1 second, then 2 seconds, subject to recipient pacing). Only definite
API rejections are automatically retried: HTTP 408/429/5xx, Meta's `is_transient`
flag, and documented temporary/rate-limit
codes: `1`, `2`, `4`, `80007`, `130429`, `131000`, `131016`, `131056`.

Network failures/timeouts and unreadable or receipt-less successful responses
are ambiguous: the request may already have been accepted. They retain `UNKNOWN`,
stop BullMQ retries, and require the recovery procedure below.

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

POST requests require `X-Hub-Signature-256`, checked against an HMAC-SHA256 of the
original request bytes using Node's constant-time comparison. The API requires
`WHATSAPP_APP_SECRET`; there is no unsigned-mode bypass. Authentication runs
before persistence/enqueue, and compressed bodies are rejected rather than
verifying a decompressed representation. GET verification remains separate.

Use the signed PowerShell example in the README. Older chapters describe the
earlier unsigned API and need this signature when used with current code.
Leave the WhatsApp worker stopped for synthetic local/dashboard examples.
No tests in this repository send live WhatsApp messages.

**Upgrade all processes together:** stop every API, AI worker, and WhatsApp
worker before migrating. Do not mix the old sender with the new `UNKNOWN` state
machine. Configure `WHATSAPP_APP_SECRET` with the Meta app secret (not the GET
verification token), then:

```powershell
docker compose up -d --wait
npm run prisma:generate
npm run prisma:migrate:deploy
npx prisma migrate status
```

Confirm all migrations are applied to the **same database used by the running
processes** before testing a webhook. Restarting the API, generating Prisma
Client, or getting a healthy `/health` response does not migrate PostgreSQL.
If the new code reports `P2022` / `messages.status does not exist`, the Phase 5
migration has not reached that database. `/health` is liveness, not schema
readiness.

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
database. `PENDING` with dispatch intent but no job is rediscovered by the relay;
check that the sender and its database/Redis connections are available.
`FAILED` is terminal: investigate safe error codes, credentials, recipient, and
service window. A BullMQ retry alone does not reset a terminal database state.

## 7. Ordering, uncertain acceptance, and recovery

The sender takes a PostgreSQL transaction-level advisory lock per user. Under
that lock it verifies the saved recipient/content/dispatch intent, checks the
oldest unsettled reply, advances `next_whatsapp_send_at`, and commits `UNKNOWN`
**before** calling Meta. No network request holds a database transaction open.

The enforced order is **saved outbound creation order** (`createdAt`, then ID),
not inbound arrival order or parallel AI generation order. An older `PENDING`
retry or `UNKNOWN` attempt blocks newer replies to that user, across conversations
and replicas. Other recipients can continue. Claims are at least six seconds
apart per recipient, using the database clock and persisted cooldown. Each worker
currently has concurrency one; adding replicas cannot bypass the recipient gate.
Deferrals move the BullMQ job to delayed without using a failed attempt.

`UNKNOWN` deliberately includes a crash after claiming but before HTTP. We cannot
prove whether a crashed process crossed the external boundary, so automatic
availability is sacrificed rather than risking a duplicate. A failed acceptance
write logs the known `providerResponseId` for investigation. Neither incoming
replay, outgoing retry, nor the relay automatically resends uncertain work.

### Explicit operator reconciliation

Stop **all** WhatsApp workers first, including replicas. The flag below records
your acknowledgement; it does not remotely stop or detect other processes.
Investigate the provider's records or a trustworthy acceptance receipt. Do not
guess `not-sent` merely because no response was logged.

```powershell
# Confirmed accepted: record the actual provider receipt; never sends HTTP.
npm run whatsapp:reconcile -- MESSAGE_UUID sent PROVIDER_RECEIPT --workers-stopped

# Confirmed NOT accepted: permit a fresh attempt.
npm run whatsapp:reconcile -- MESSAGE_UUID not-sent --workers-stopped
```

Only an authenticated dispatch currently in `UNKNOWN` can be reconciled.
`sent` records `SENT` and its receipt. `not-sent` first removes the old failed
BullMQ job, then changes the database state to `PENDING`; a non-failed queue job
is refused. If the command crashes before the database update, the row remains
`UNKNOWN`. If it crashes afterwards, the relay recovers it on sender restart.
The command needs database/Redis configuration, not AI or Meta credentials, and
does not start a sending worker. Resume senders only after the decision succeeds.

This is not exactly-once delivery or automatic receipt reconciliation. If no
trustworthy acceptance decision is available, leave the reply `UNKNOWN`.
Provider-wide quotas, distributed clock operations, monitoring, and delivery/read
status webhooks still need production design. A failed terminal status write can
leave a `PENDING` row with a failed job; that requires investigation rather than
automatic reactivation of a terminal failure. History includes stored pending,
failed, and uncertain replies, not only delivered messages.

This phase does not add caching, RAG, embeddings, business workflows, or
automatic scaling.

## 8. Verification and references

Run `npm test`, then `npm run test:integration`, sequentially. Unit tests cover
configuration isolation, HTTP authentication and payloads, response parsing,
timeouts, retry classification, log privacy, and duplicate-send guards.
Integration tests use real Redis and a throwaway PostgreSQL database with fake
AI and fake Meta HTTP responses. They exercise the webhook -> AI -> outgoing
queue -> WhatsApp worker -> receipt path, transient recovery, exhausted retries,
permanent rejection, and migration over existing rows. They do not prove that
your live credentials or Meta account are configured correctly.

Recovery coverage includes a fresh relay after save-then-crash, concurrent
recipient claims, retry ordering and shared pacing, acceptance followed by a
lost response, refusal to resend UNKNOWN work, and explicit operator recovery.
Run queue tests that execute `SCRIPT FLUSH` only against a separate test Redis,
never a shared live Redis; all other fixtures use private queue prefixes.

- [Meta text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages)
- [Meta error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
- [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ unrecoverable errors](https://docs.bullmq.io/patterns/stop-retrying-jobs)
- [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids)

**Previous:** [Chapter 5 - AI Integration](05-ai-integration.md)
