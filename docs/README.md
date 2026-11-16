# liteBot learning guide

This guide explains how liteBot is built, one stage at a time. Each chapter
describes what that stage added, why it was needed, how it works, and how to
check it yourself. Read the chapters in order; later ones build on earlier ones.

| Chapter                                                              | You will learn                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [1. Bootstrap](01-bootstrap.md)                                      | How the project is set up, how a request reaches `/health`, and why each tool exists                                                          |
| [2. Webhook Foundation (Phase 1)](02-webhook-foundation.md)          | Ownership verification, dashboard/tunnel setup, payload validation, safe logging, and HTTP errors                                             |
| [3. Queue Infrastructure (Phase 2)](03-queue-infrastructure.md)      | Webhook → BullMQ → worker, job contract, correlation IDs, retries, shutdown, delivery limits, and who starts workers                          |
| [4. Persistence Layer (Phase 3)](04-persistence-layer.md)            | PostgreSQL as the source of truth, the data model and WhatsApp conversations, migrations, repositories, transactions, locks, and duplicates   |
| [5. AI Integration (Phase 4)](05-ai-integration.md)                  | Provider abstraction, prompt construction, recent context from PostgreSQL, Azure AI Foundry, and saved-but-unsent responses                   |
| [6. Outbound WhatsApp Messaging (Phase 5)](06-outbound-messaging.md) | Separate generation and transport, Cloud API authentication, outgoing jobs, acceptance receipts, retry classification, and persisted statuses |

The user numbers the implementation phases from the webhook work, so Phase 1 is
Chapter 2, Phase 2 is Chapter 3, Phase 3 is Chapter 4, Phase 4 is Chapter 5,
and Phase 5 is Chapter 6;
the earlier bootstrap stays Chapter 1. Future chapters can cover authenticated
deliveries, delivery-status webhooks, and reliability improvements. Automatic worker
startup and scaling will be revisited after the end-to-end proof of concept works
([Chapter 3, section 13](03-queue-infrastructure.md#13-who-starts-the-worker-automatic-scaling-is-deferred)).

For the practical Meta connection steps, start with the
[dashboard walkthrough](../README.md#connect-to-the-meta-dashboard). For the
API-plus-worker overview, see
[Asynchronous Processing](../README.md#asynchronous-processing); for what is
stored and why, see [Persistence Layer](../README.md#persistence-layer).

## Glossary

Terms are added here as chapters introduce them.

| Term                         | Meaning                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container                    | An isolated, lightweight process with its own filesystem, started from an image.                                                                                    |
| Docker Compose               | A tool that starts several containers from one YAML file (`docker-compose.yml`).                                                                                    |
| Environment var              | A named setting given to a process from outside the code, such as `PORT=3000`.                                                                                      |
| ES module (ESM)              | JavaScript's standard module system, using `import`/`export`.                                                                                                       |
| Express                      | A minimal Node.js framework for handling HTTP requests.                                                                                                             |
| Health check                 | An endpoint that reports whether a service is running, used by load balancers and monitors.                                                                         |
| Linter                       | A tool that reads code and reports likely bugs or banned patterns (here: ESLint).                                                                                   |
| Middleware                   | A function that runs on every request before (or after) the route handler.                                                                                          |
| ORM                          | Object–relational mapper: a library that lets code query a database using objects (Prisma).                                                                         |
| Structured log               | A log line written as JSON fields rather than free text, so tools can search and filter it.                                                                         |
| Regression test              | A test that reproduces a bug and guards against bringing it back in a later change.                                                                                 |
| Challenge-response           | A handshake where the receiver proves control by returning a value sent by the verifier.                                                                            |
| Runtime validation           | Checking actual incoming data while the program runs; TypeScript types alone cannot do this.                                                                        |
| Dependency injection         | Passing a dependency, such as a logger or configuration value, into code instead of constructing it there.                                                          |
| Payload projection           | A new object containing only explicitly selected fields from a larger payload.                                                                                      |
| Transpile                    | Convert source code from one language to another, here TypeScript to JavaScript.                                                                                    |
| Webhook                      | A URL that another service calls to tell us something happened (Meta calls ours on messages).                                                                       |
| Callback URL                 | The public endpoint address registered with another service so it knows where to send notifications.                                                                |
| HTTPS tunnel                 | A public HTTPS endpoint that forwards requests to a server running on your computer.                                                                                |
| Webhook subscription         | A selection of event categories, such as `messages`, that an app asks the provider to deliver.                                                                      |
| Asynchronous                 | Done later, outside the request that asked for it, so the caller does not wait for the work to finish.                                                              |
| Queue                        | A waiting list of work items; producers add items and consumers take them out in order.                                                                             |
| Job                          | One unit of queued work; here, one incoming text message plus its correlation ID.                                                                                   |
| Producer                     | Code that adds jobs to a queue: the API produces incoming jobs, and the AI worker produces outgoing jobs.                                                           |
| Worker (consumer)            | A process that takes jobs from a queue: `src/worker.ts` generates replies and `src/whatsapp.worker.ts` sends them.                                                  |
| Redis                        | An in-memory data store; BullMQ keeps its queues there.                                                                                                             |
| BullMQ                       | A Node.js job-queue library built on Redis, with retries, backoff, and job states.                                                                                  |
| Exponential backoff          | Waiting longer before each retry, typically doubling the delay (here ~1 s, then ~2 s).                                                                              |
| Correlation ID               | An ID attached to one request and copied into every related log and job, so they can be traced together.                                                            |
| Port (interface)             | A small interface describing what code needs (for example, "enqueue messages"), hiding the implementation.                                                          |
| Liveness vs readiness        | Liveness: "is the process running?" Readiness: "can it do useful work now?" `/health` is liveness only.                                                             |
| At-least-once                | A delivery guarantee where work is not silently lost but may occasionally happen more than once.                                                                    |
| Idempotency                  | The property that doing the same operation twice has the same effect as doing it once.                                                                              |
| Lua script cache             | Redis's in-memory store of loaded scripts; it is empty after a restart, causing `NOSCRIPT` errors.                                                                  |
| Stalled job                  | A job whose worker stopped renewing its lock; BullMQ moves it back to waiting, or to failed if it stalls too often.                                                 |
| Graceful shutdown            | Stopping a process by finishing or handing back in-progress work and closing connections cleanly.                                                                   |
| Worker concurrency           | How many jobs one worker process handles at the same time (BullMQ's `concurrency` option; default 1).                                                               |
| Replica                      | One running copy of the same service; more worker replicas process more jobs in parallel.                                                                           |
| Autoscaling                  | A platform automatically adding or removing replicas based on a measure such as queue backlog.                                                                      |
| KEDA                         | Kubernetes Event-driven Autoscaling: scales replicas from event sources like Redis lists; Azure Container Apps uses it.                                             |
| Source of truth              | The one store whose answer wins when stores disagree; since Phase 3, PostgreSQL.                                                                                    |
| Operational vs durable state | Operational: work in progress, such as queued jobs, that can be discarded later. Durable: facts that must survive restarts and crashes.                             |
| Relational database          | A database that stores data in tables of rows and columns and links tables through keys; here, PostgreSQL.                                                          |
| Table, row, column           | A table holds one kind of record; each row is one record; each column is one named, typed field.                                                                    |
| Primary key (PK)             | The column whose value uniquely identifies each row of a table, here always `id`.                                                                                   |
| Foreign key (FK)             | A column that must contain the primary key of an existing row in another table, such as `messages.conversation_id`.                                                 |
| Unique constraint            | A database rule that refuses a second row with the same value in a column, such as `users.phone_number`.                                                            |
| Index                        | A sorted lookup structure that lets the database find rows without reading the whole table.                                                                         |
| Migration                    | A committed SQL file that moves a database from one schema version to the next.                                                                                     |
| Prisma schema                | `prisma/schema.prisma`: the file describing models (tables), fields (columns), and relations.                                                                       |
| Prisma Client                | TypeScript code generated from the schema, with typed query methods such as `prisma.user.findUnique`.                                                               |
| Driver adapter               | Prisma 7's bridge to a database driver; here `@prisma/adapter-pg`, which uses node-postgres and its connection pool.                                                |
| Connection pool              | A set of open database connections that are reused across queries instead of opened for each one.                                                                   |
| Repository                   | An object that offers collection-like access to stored data ("find the user with this phone number") and hides how it is stored.                                    |
| Domain type                  | A plain TypeScript type for a business concept, such as `Message`, that does not depend on the database library.                                                    |
| Transaction                  | A group of database changes that succeed or fail together.                                                                                                          |
| Commit / rollback            | Commit makes all of a transaction's changes permanent; rollback discards all of them.                                                                               |
| Unit of work                 | An object that runs several repository calls inside one transaction.                                                                                                |
| Race condition               | A bug whose outcome depends on the exact timing of two operations that both read and then write.                                                                    |
| Advisory lock                | A PostgreSQL lock on an application-chosen number; here, one per sender, held until the transaction ends.                                                           |
| Isolation level              | How much one transaction sees of others' changes; PostgreSQL's default, Read Committed, shows data committed before each statement.                                 |
| UUIDv7                       | A 128-bit identifier that starts with a timestamp, so new IDs sort roughly by creation time.                                                                        |
| `timestamptz`                | PostgreSQL's `timestamp with time zone`: an absolute instant, stored internally as UTC.                                                                             |
| Composition root             | The one place, here `src/server.ts`, where the application's objects are created and wired together.                                                                |
| Transactional outbox         | A pattern that writes a "to be published" record in the same transaction as the data, so a later step can publish it reliably.                                      |
| WhatsApp conversation        | Conversation data that Meta defines and reports, such as an ID, category, and expiry; liteBot stores it but never decides conversation boundaries itself.           |
| Status webhook               | A webhook reporting that a message the business sent was `sent`, `delivered`, `read`, or `failed`; the only webhook that can carry conversation data.               |
| Customer service window      | The 24 hours after a user's latest message, during which the business may send any message type; afterwards only approved templates.                                |
| Free entry point window      | A window of up to 7 days, opened when a user arrives from a Click to WhatsApp ad and the business replies in time, in which Meta does not charge for most messages. |
| AI memory (assistant thread) | The context an AI assistant keeps across messages, defined by our own rules; a separate concept from a WhatsApp conversation.                                       |
| Backfill                     | Filling a newly added column for rows that existed before it, usually inside the migration that adds it.                                                            |
| `prisma migrate diff`        | A read-only Prisma command that prints the SQL needed to move one schema state, such as a live database, to another.                                                |
| AI provider                  | An adapter that implements the application's AI contract while hiding a vendor's SDK and request format.                                                            |
| Provider abstraction         | An interface that lets application code request a capability without depending on the service that provides it.                                                     |
| Prompt                       | The instructions and conversation messages sent to an AI model for one response.                                                                                    |
| Prompt builder               | Code that combines the system prompt, recent conversation messages, and the current user message into chat context.                                                 |
| System prompt                | An application-authored instruction that establishes the assistant's role for a model request.                                                                      |
| Model deployment             | A named model endpoint configured in Azure AI Foundry; the deployment name is sent in the request's `model` field.                                                  |
| Chat completion              | A generated assistant message based on an ordered list of system, user, and assistant messages.                                                                     |
| Acceptance receipt           | Meta's response ID confirming it accepted a send request; not proof of recipient delivery.                                                                          |
| Bearer token                 | A secret sent in an Authorization header; whoever holds it can exercise its permissions.                                                                            |
| Transient vs permanent error | A temporary failure worth retrying versus a rejection that needs configuration, input, or policy changes.                                                           |
| `UnrecoverableError`         | BullMQ's way to stop automatic retries for a permanently failing job.                                                                                               |
| Reply link                   | A unique `reply_to_message_id` associating a saved AI reply with the inbound message that caused it.                                                                |
| Reconciliation               | Comparing external, queue, and database state after failures to find and repair inconsistencies.                                                                    |
