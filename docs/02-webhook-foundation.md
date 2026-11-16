# Chapter 2 - Phase 1: WhatsApp Webhook Foundation

The bootstrap chapter built a program that could answer `/health`. This phase
adds an address Meta can use for webhook verification and notifications.
It deliberately stops at receiving, checking, logging, and acknowledging requests.
There are no database writes, queue jobs, provider calls, or message processing.

The chapter number and phase number differ because the user named this work
"Phase 1" after the bootstrap had already been completed.

## 1. Two HTTP methods, two different jobs

A route is selected by both its path and its HTTP method. These requests use
the same path but do different things:

| Request         | Purpose                                               | Successful response                    |
| --------------- | ----------------------------------------------------- | -------------------------------------- |
| `GET /webhook`  | Prove control of the callback URL during subscription | `200` with the challenge as plain text |
| `POST /webhook` | Receive an event notification                         | `200` with `OK`                        |

Neither sends a WhatsApp reply. Returning `200` to Meta acknowledges its HTTP
request; it is not a message to the WhatsApp user.

## 2. Why ownership verification exists

Meta should not accept an arbitrary URL merely because someone typed it into a
dashboard. The owner of that URL must demonstrate that they intentionally
configured an endpoint that understands the subscription handshake.

1. Choose a private, non-empty verification token and put it in
   `WHATSAPP_VERIFY_TOKEN` in `.env`.
2. Configure the callback URL and the same token in Meta's dashboard.
3. Meta sends a GET request containing `hub.mode=subscribe`,
   `hub.verify_token`, and `hub.challenge`.
4. Our controller compares the received token with the configured one.
5. If the mode and token match, it returns the challenge unchanged.

The challenge is a value Meta supplies, not a secret we generate. Although it
normally looks like a number, we handle it as text: `000742` stays `000742`.
Returning a JSON object, a quoted JSON string, or a converted number would not
be the same response.

The verification token is chosen by us. It is different from a WhatsApp access
token, which authorizes API calls, and from the Meta app secret used to verify
delivery signatures.

| Verification input                                                          | Result                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| `subscribe`, matching token, one non-empty challenge                        | `200`, plain-text challenge                         |
| Wrong/missing mode, wrong/missing/empty token, or repeated token parameters | `403`, `{"error":"Forbidden"}`                      |
| Matching mode/token but missing, blank, or repeated challenge               | `400`, `{"error":"Invalid verification challenge"}` |

Repeated query parameters can become arrays rather than strings. Checking their
runtime type avoids accidentally accepting ambiguous input.

## 3. Configuration and dependency injection

`src/config/env.ts` now requires `WHATSAPP_VERIFY_TOKEN` when the server starts.
A missing or whitespace-only token stops startup with an error that names the
setting but does not print a token value. Existing `.env` files from bootstrap
must be updated; the application will not invent a fallback token.

`src/server.ts` assembles the dependencies:

```text
read and validate env
        |
        +--> createLogger(env.logLevel)
        |
        +--> createApp({ logger, whatsappVerifyToken })
                         |
                         +--> new WebhookController(token, logger)
                         +--> createErrorMiddleware(logger)
        |
        +--> listen on the configured port
```

This is **dependency injection**: the controller receives its token and logger
instead of reading environment variables or constructing a logger itself.
No dependency-injection framework is needed.

The app can consequently be tested with a synthetic token and an in-memory log
destination. Importing `app.ts` no longer loads `.env` or opens infrastructure
connections. The normal server still loads dotenv through the environment module.

## 4. Following an incoming POST

```text
POST /webhook with Content-Type: application/json
        |
pino-http starts timing the request
        |
express.json() parses the JSON body
        |
webhook.route.ts selects handleIncomingWebhook()
        |
parseWebhookPayload(req.body) checks the entire batch
        |
log the sanitized payload once, then each event's metadata
        |
200 OK

Malformed input --> error middleware --> 400
Unexpected error --> error middleware --> 500
```

There is no network or database work between validation and acknowledgement.
Iterating over entries and messages only extracts log metadata; it does not
process the message content. The existing JSON parser limits request bodies
to 100 KB, so this is a bounded local prototype, not a complete production
ingestion policy for every possible Meta event size.

The router uses `.bind(controller)` when registering each method. Express calls
the registered function later; binding preserves the controller instance as
`this`, so its token and logger remain available inside the method.

## 5. TypeScript interfaces are not runtime validation

TypeScript types help while writing and compiling code. They do not make an
incoming HTTP body trustworthy: a caller can send `null`, strings, incorrect
arrays, or a completely unrelated object.

The POST handler therefore receives the body as `unknown`. Only after
`parseWebhookPayload` checks it do we have a `WebhookPayload`.

The four interfaces live in
[`webhook.types.ts`](../src/shared/types/webhook.types.ts):

| Interface        | Fields modeled now                                            |
| ---------------- | ------------------------------------------------------------- |
| `WebhookPayload` | Literal object type `whatsapp_business_account`, and entries  |
| `WebhookEntry`   | Business-account entry ID and changes                         |
| `WebhookChange`  | Changed field name and an object value with optional messages |
| `Message`        | Message ID and optional sender phone number (`from`)          |

This `Message` describes a small part of Meta's transport payload. It is not a
Prisma model or the future application's persisted message entity.

### The exact validation boundary

- `object` must be `whatsapp_business_account`.
- `entry` must be a non-empty array.
- Each entry needs a non-empty string `id` and a non-empty `changes` array.
- Each change needs a non-empty string `field` and a non-null, non-array object `value`.
- If `value.messages` is present, it must be an array.
- Each message needs a non-empty string `id`. If `from` is present, it must be a
  non-empty string; a missing phone number is allowed.

Why optional messages? Meta also uses the `messages` webhook for delivery-status
events, whose value contains `statuses` instead. We accept those envelopes and
log the changed field without pretending they contain incoming messages.
An empty messages array is also accepted.

Why optional phone numbers? Current Meta documentation allows the sender's
phone number to be omitted for users identified by a business-scoped user ID.
We do not invent a phone number or reject such a message.

Unknown fields are accepted for compatibility but neither modeled nor inspected.
This is intentionally partial validation: it does not validate text content,
media objects, status details, or every Meta-specific field.

The parser checks the entire batch before any accepted-payload logging. A valid
first entry followed by an invalid second entry produces a `400`, not partial
success logs.

## 6. Logging without copying private message content

We log a **projection**: a newly constructed object containing only the fields
listed above, not the original `req.body`. This avoids accidentally copying
contact profiles, message text, or unknown secret-bearing fields to logs.

For a message event, a separate metadata record contains:

```json
{
  "eventType": "messages",
  "phoneNumber": "15550000001",
  "messageId": "wamid.local-example",
  "msg": "WhatsApp webhook event received"
}
```

`eventType` is `change.field`, not the message's content type. `phoneNumber`
comes from the incoming message's `from` field, not the business account's
display number. Missing phone numbers are omitted. Status-only events get an
event record without message metadata because we do not model status details yet.

The sanitized batch is logged once, rather than repeating it for every message.
This keeps the amount of log data proportional to the request size.

The HTTP request serializer also omits query strings and request headers.
This matters because the GET verification token is in the URL query, and
headers may contain access tokens or cookies. Malformed request bodies are not
included in error logs either.

Phone numbers and message IDs are still identifying data. Use synthetic examples
locally and establish log access and retention controls before accepting real users.

## 7. Error handling

`createErrorMiddleware(logger)` installs a four-argument Express error handler
after the routes. Express forwards thrown controller errors to that middleware;
the controller does not need a catch-all around every statement.

- The validator throws `BadRequestError` for invalid structure.
- JSON parser errors, such as broken JSON or an oversized body, are also treated
  as client input failures. These return `400` with `{"error":"Malformed request"}`.
- Unexpected failures are logged server-side and return `500` with
  `{"error":"Internal server error"}`. Internal error messages and stacks are
  not returned to the caller.
- If headers have already been sent, the handler delegates to Express rather
  than trying to send a second response.

The existing `/health` contract stays exactly `{"status":"healthy"}`.
Unmatched routes retain Express's existing `404` behavior.

## 8. Verification and local use

Follow the [README setup and webhook examples](../README.md#webhook-verification).
No database, Redis, Meta account, or AI credentials are needed for local examples.
Only the verification token must be configured to start the server.

```powershell
npm test
node --import tsx --test tests/webhook.test.ts
node --import tsx --test --test-name-pattern="POST acknowledges" tests/webhook.test.ts
npm run typecheck
npm run lint
npm run build
npm run format:check
```

The tests cover the challenge response, bad tokens/modes, missing and repeated
parameters, batch metadata, optional phone numbers, status-only changes,
malformed envelopes, broken JSON, body-size limits, and a generic unexpected
failure. They also assert that tokens and private payload fields do not appear
in logs. Bootstrap tests still cover health and startup failure behavior.

## 9. Ownership is not authenticity

The GET handshake proves control of the callback endpoint during subscription.
It does **not** prove that every later POST came from Meta. Anyone who can reach
this foundation can submit a structurally valid JSON body.

Before public deployment, add Meta's `X-Hub-Signature-256` validation over the
raw request body using the app secret, and serve the callback over HTTPS.
This phase does not implement those mechanisms or claim production authentication.
It also does not deduplicate deliveries or guarantee durable receipt.

Persistence, queues, AI generation, and replies remain separate future phases.

## Official references

- [Meta: webhook verification and event notifications](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
- [Meta: WhatsApp messages envelopes, statuses, and optional phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages)
- [Express: error handling](https://expressjs.com/en/guide/error-handling.html)
