# liteBot learning guide

This guide explains how liteBot is built, one stage at a time. Each chapter
describes what that stage added, why it was needed, how it works, and how to
check it yourself. Read the chapters in order; later ones build on earlier ones.

| Chapter                                                         | You will learn                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [1. Bootstrap](01-bootstrap.md)                                 | How the project is set up, how a request reaches `/health`, and why each tool exists                                 |
| [2. Webhook Foundation (Phase 1)](02-webhook-foundation.md)     | Ownership verification, dashboard/tunnel setup, payload validation, safe logging, and HTTP errors                    |
| [3. Queue Infrastructure (Phase 2)](03-queue-infrastructure.md) | Webhook → BullMQ → worker, job contract, correlation IDs, retries, shutdown, delivery limits, and who starts workers |

The user numbers the implementation phases from the webhook work, so Phase 1 is
Chapter 2 and Phase 2 is Chapter 3; the earlier bootstrap stays Chapter 1.
Upcoming chapters will cover authenticated deliveries, the data model, AI
replies, and the end-to-end flow. Automatic worker startup and scaling will be
revisited after the end-to-end proof of concept works
([Chapter 3, section 13](03-queue-infrastructure.md#13-who-starts-the-worker-automatic-scaling-is-deferred)).

For the practical Meta connection steps, start with the
[dashboard walkthrough](../README.md#connect-to-the-meta-dashboard). For the
API-plus-worker overview, see
[Asynchronous Processing](../README.md#asynchronous-processing).

## Glossary

Terms are added here as chapters introduce them.

| Term                  | Meaning                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Container             | An isolated, lightweight process with its own filesystem, started from an image.                                        |
| Docker Compose        | A tool that starts several containers from one YAML file (`docker-compose.yml`).                                        |
| Environment var       | A named setting given to a process from outside the code, such as `PORT=3000`.                                          |
| ES module (ESM)       | JavaScript's standard module system, using `import`/`export`.                                                           |
| Express               | A minimal Node.js framework for handling HTTP requests.                                                                 |
| Health check          | An endpoint that reports whether a service is running, used by load balancers and monitors.                             |
| Linter                | A tool that reads code and reports likely bugs or banned patterns (here: ESLint).                                       |
| Middleware            | A function that runs on every request before (or after) the route handler.                                              |
| ORM                   | Object–relational mapper: a library that lets code query a database using objects (Prisma).                             |
| Structured log        | A log line written as JSON fields rather than free text, so tools can search and filter it.                             |
| Regression test       | A test that reproduces a bug and guards against bringing it back in a later change.                                     |
| Challenge-response    | A handshake where the receiver proves control by returning a value sent by the verifier.                                |
| Runtime validation    | Checking actual incoming data while the program runs; TypeScript types alone cannot do this.                            |
| Dependency injection  | Passing a dependency, such as a logger or configuration value, into code instead of constructing it there.              |
| Payload projection    | A new object containing only explicitly selected fields from a larger payload.                                          |
| Transpile             | Convert source code from one language to another, here TypeScript to JavaScript.                                        |
| Webhook               | A URL that another service calls to tell us something happened (Meta calls ours on messages).                           |
| Callback URL          | The public endpoint address registered with another service so it knows where to send notifications.                    |
| HTTPS tunnel          | A public HTTPS endpoint that forwards requests to a server running on your computer.                                    |
| Webhook subscription  | A selection of event categories, such as `messages`, that an app asks the provider to deliver.                          |
| Asynchronous          | Done later, outside the request that asked for it, so the caller does not wait for the work to finish.                  |
| Queue                 | A waiting list of work items; producers add items and consumers take them out in order.                                 |
| Job                   | One unit of queued work; here, one incoming text message plus its correlation ID.                                       |
| Producer              | The code that adds jobs to a queue; here, the webhook in the API process.                                               |
| Worker (consumer)     | A process that takes jobs from a queue and processes them; here, `src/worker.ts`.                                       |
| Redis                 | An in-memory data store; BullMQ keeps its queues there.                                                                 |
| BullMQ                | A Node.js job-queue library built on Redis, with retries, backoff, and job states.                                      |
| Exponential backoff   | Waiting longer before each retry, typically doubling the delay (here ~1 s, then ~2 s).                                  |
| Correlation ID        | An ID attached to one request and copied into every related log and job, so they can be traced together.                |
| Port (interface)      | A small interface describing what code needs (for example, "enqueue messages"), hiding the implementation.              |
| Liveness vs readiness | Liveness: "is the process running?" Readiness: "can it do useful work now?" `/health` is liveness only.                 |
| At-least-once         | A delivery guarantee where work is not silently lost but may occasionally happen more than once.                        |
| Idempotency           | The property that doing the same operation twice has the same effect as doing it once.                                  |
| Lua script cache      | Redis's in-memory store of loaded scripts; it is empty after a restart, causing `NOSCRIPT` errors.                      |
| Stalled job           | A job whose worker stopped renewing its lock; BullMQ moves it back to waiting, or to failed if it stalls too often.     |
| Graceful shutdown     | Stopping a process by finishing or handing back in-progress work and closing connections cleanly.                       |
| Worker concurrency    | How many jobs one worker process handles at the same time (BullMQ's `concurrency` option; default 1).                   |
| Replica               | One running copy of the same service; more worker replicas process more jobs in parallel.                               |
| Autoscaling           | A platform automatically adding or removing replicas based on a measure such as queue backlog.                          |
| KEDA                  | Kubernetes Event-driven Autoscaling: scales replicas from event sources like Redis lists; Azure Container Apps uses it. |
