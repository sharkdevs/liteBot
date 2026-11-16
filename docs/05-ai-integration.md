# Chapter 5 - Phase 4: AI Integration

Chapter 4 made PostgreSQL the source of truth for inbound messages. At that
point, the worker only logged each queued job. This phase teaches the worker to
load recent messages, ask an AI provider for a reply, and save that reply as an
`OUTBOUND` message. It still does **not** send a WhatsApp message.

> **Phase 5 update:** this chapter explains the Phase 4 milestone. The current AI
> worker also queues its saved reply for a separate sending worker, and retries
> reuse the same reply ID. See [Chapter 6](06-outbound-messaging.md). Leave the
> WhatsApp worker stopped to reproduce this chapter's saved-but-unsent behavior.

```text
Webhook
   |
Persist Message
   |
Queue
   |
Worker
   |
Prompt Builder
   |
IAiProvider
   |
Azure AI Foundry
   |
Store AI Response
```

By the end of this chapter you should understand:

1. Why the rest of the application talks to an AI-provider interface instead of
   directly to a vendor SDK.
2. How saved messages become a bounded prompt for a chat-completions request.
3. Why PostgreSQL, rather than a model, owns conversation context.
4. How the worker saves and logs a generated response without sending it.

## 1. Keep the model vendor behind an interface

`IAiProvider` is the application's small contract for text generation:

```ts
generateResponse(userMessage: string, conversationHistory: Message[]): Promise<string>
```

The worker and application services use this interface. They do not import the
OpenAI SDK or know how Azure authenticates. `AzureAiFoundryProvider` is one
implementation; a factory selects it from `AI_PROVIDER`. `OpenAIProvider` and
`GeminiProvider` are placeholders that currently fail with `Not implemented`.
They show where another vendor adapter can go, but they are not usable models
yet.

The default provider is `azure-foundry`. The Azure implementation uses the
project's already-installed OpenAI JavaScript SDK to call the Foundry OpenAI v1
endpoint. In that API, `AZURE_AI_MODEL` is the **deployment name** sent in the
`model` field. A deployment is the name configured for a model in your Foundry
resource; it may differ from the model's catalog name.

The provider reads the deployment name from configuration. To change to another
model available on the same Foundry endpoint, configure a deployment for that
model and set `AZURE_AI_MODEL` to that deployment's name. Changing vendors later
means implementing the corresponding provider and selecting it through
`AI_PROVIDER`; the placeholder providers deliberately do not pretend to work.

## 2. Build the prompt separately from the provider

The default system instruction lives in
[`src/prompts/system.prompt.ts`](../src/prompts/system.prompt.ts):

> You are a helpful WhatsApp assistant.

`PromptBuilder` turns stored messages into chat roles:

| Stored message direction | Chat role   |
| ------------------------ | ----------- |
| `INBOUND`                | `user`      |
| `OUTBOUND`               | `assistant` |

It adds the system instruction, preserves chronological order, and appends the
current inbound text. At most 20 conversational messages are sent: the current
message plus up to 19 earlier messages. The system instruction is additional
and does not count toward that limit. The current inbound row is already saved
before the job is queued, so the history query excludes that row before the
builder appends its text.

Keeping prompt text and history formatting out of the Azure adapter has two
benefits. The prompt can be reviewed and changed without editing transport code,
and a future adapter can use the same application-level conversation context
while translating it to its vendor's request format.

## 3. Application storage owns conversation context

The worker retrieves recent messages from PostgreSQL, which remains the source
of truth. It does not depend on an LLM retaining a previous request, and there
is no Redis conversation cache in this phase. This makes the context reproducible
from saved records and keeps provider-specific state out of the domain model.

A WhatsApp `Conversation` still means the conversation metadata reported by
Meta. It is not an AI thread or memory store. The worker uses the existing
`Message` rows for short-term prompt context; summaries, facts, embeddings, RAG,
and any separate AI-memory model are not part of this phase.

## 4. Save the response, but do not send it

For each job, the worker:

1. Loads recent messages for the job's conversation, excluding the current
   inbound row.
2. Calls `IAiProvider.generateResponse` with the current text and history. The
   Azure adapter uses `PromptBuilder` to create the chat-completions payload.
3. Stores the returned text as a new `OUTBOUND` message with no WhatsApp message
   ID, because it has not been sent.
4. Logs the saved response's identifiers, configured model name, and response
   length.

The log intentionally does **not** contain the generated text. Project logging
rules avoid writing message content to logs; `responseLength` confirms that a
reply was generated without exposing its contents.

If model generation or persistence fails, the worker reports a job failure so
BullMQ can retry it. Each Azure request uses a **30-second SDK timeout**, with
SDK retries disabled. The SDK otherwise waits up to ten minutes per request
and retries failures twice internally, which can make a job appear stuck long
before BullMQ sees a failure. BullMQ alone owns the retry policy: three total
attempts, with exponential delays starting at one second. A slow or unavailable
deployment can still exhaust those attempts; the timeout does not fix upstream
availability.

The worker logs `AI response generation started` immediately before calling the
provider. On success, `AI response generated and saved` includes `durationMs`
(generation plus persistence), the inbound `messageId`, and the saved
`responseMessageId`. These distinguish a pending provider call from a saved reply
without exposing either message's text.

At the end of Phase 4, a retry after saving could create another outbound row.
Phase 5 adds a unique reply-to-message link so publication retries reuse the
saved row; external delivery is still at-least-once, as Chapter 6 explains.

## 5. Configure and run it

Copy `.env.example` to `.env`, then set the Azure values for the worker:

| Variable                    | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`               | Provider selection: `azure-foundry` by default; `openai` and `gemini` currently select placeholders. |
| `AZURE_AI_FOUNDRY_ENDPOINT` | Foundry OpenAI v1 endpoint, such as `https://<resource>.services.ai.azure.com/openai/v1/`.           |
| `AZURE_AI_FOUNDRY_API_KEY`  | API key for the Foundry resource. Keep the real value in the uncommitted `.env`.                     |
| `AZURE_AI_MODEL`            | Deployment name passed to the model API; defaults to the example `phi-4-mini`.                       |
| `DATABASE_URL`              | PostgreSQL connection used by both the API and worker.                                               |

The API does not require the AI provider settings. The worker needs PostgreSQL
to load history and save responses, as well as Redis for BullMQ. A real request
to Azure requires a reachable, correctly configured Foundry deployment; the
automated provider tests use a local fake HTTP response and do not call Azure.

Start the local services, apply the existing migrations, then run the API and
worker in separate terminals:

```powershell
docker compose up -d --wait
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

```powershell
npm run dev:worker
```

Run the unit and HTTP tests with `npm test`. The end-to-end worker test uses a
fake provider but real PostgreSQL and Redis, so run it with:

```powershell
npm run test:integration
```

That command uses isolated queue keys and a throwaway test database. It does not
call Azure or send WhatsApp messages.

### Verify a live run

The API returning 200 confirms inbound persistence and queue acceptance, not AI
completion. Keep the worker terminal open and follow the same `messageId` through
`AI response generation started` and either `AI response generated and saved` or
`Incoming message job failed`. Failed attempts are followed by retries until the
queue's attempt limit is reached.

For the local Compose database, copy `responseMessageId` from the saved-response
log into this read-only query:

```powershell
docker compose exec -T postgres psql -U litebot -d litebot -P pager=off -c "SELECT id, conversation_id, direction, created_at, length(content) AS characters FROM messages WHERE id = 'PASTE_RESPONSE_MESSAGE_ID';"
```

An `OUTBOUND` row confirms that the generated reply was persisted; it does not
mean WhatsApp delivered it. If `DATABASE_URL` points to a different PostgreSQL
instance, query that instance instead.

## 6. What this phase does not include

- Sending the saved response to WhatsApp.
- Redis conversation caching.
- Application-specific business workflows.
- RAG, embeddings, summaries, or long-term AI memory.
- Idempotent response generation or a transactional outbox.
- Webhook signature verification or production deployment.

**Previous:** [Chapter 4 - Persistence Layer (Phase 3)](04-persistence-layer.md)

**Next:** [Chapter 6 - Outbound WhatsApp Messaging (Phase 5)](06-outbound-messaging.md)

## Official references

- [Microsoft Foundry model endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints) documents the OpenAI JavaScript SDK, the `/openai/v1/` endpoint, API-key authentication, and using a deployment name in `model`. It also notes that Chat Completions is the alternative when a model doesn't support the Responses API.
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat) documents the `/chat/completions` operation and its messages payload.
- [OpenAI SDK timeouts](https://github.com/openai/openai-node#timeouts) and [retries](https://github.com/openai/openai-node#retries) document the defaults and the `timeout` / `maxRetries` client options used to hand retry control to BullMQ.
