# liteBot learning guide

This guide explains how liteBot is built, one stage at a time. Each chapter
describes what that stage added, why it was needed, how it works, and how to
check it yourself. Read the chapters in order; later ones build on earlier ones.

| Chapter                                                     | You will learn                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [1. Bootstrap](01-bootstrap.md)                             | How the project is set up, how a request reaches `/health`, and why each tool exists |
| [2. Webhook Foundation (Phase 1)](02-webhook-foundation.md) | Ownership verification, runtime payload validation, safe logging, and HTTP errors    |

The user named the webhook work "Phase 1"; the earlier bootstrap stays Chapter 1.
Upcoming chapters will cover authenticated deliveries, the data model, queues
and workers, AI replies, and the end-to-end flow.

## Glossary

Terms are added here as chapters introduce them.

| Term                 | Meaning                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Container            | An isolated, lightweight process with its own filesystem, started from an image.                           |
| Docker Compose       | A tool that starts several containers from one YAML file (`docker-compose.yml`).                           |
| Environment var      | A named setting given to a process from outside the code, such as `PORT=3000`.                             |
| ES module (ESM)      | JavaScript's standard module system, using `import`/`export`.                                              |
| Express              | A minimal Node.js framework for handling HTTP requests.                                                    |
| Health check         | An endpoint that reports whether a service is running, used by load balancers and monitors.                |
| Linter               | A tool that reads code and reports likely bugs or banned patterns (here: ESLint).                          |
| Middleware           | A function that runs on every request before (or after) the route handler.                                 |
| ORM                  | Object–relational mapper: a library that lets code query a database using objects (Prisma).                |
| Structured log       | A log line written as JSON fields rather than free text, so tools can search and filter it.                |
| Regression test      | A test that reproduces a bug and guards against bringing it back in a later change.                        |
| Challenge-response   | A handshake where the receiver proves control by returning a value sent by the verifier.                   |
| Runtime validation   | Checking actual incoming data while the program runs; TypeScript types alone cannot do this.               |
| Dependency injection | Passing a dependency, such as a logger or configuration value, into code instead of constructing it there. |
| Payload projection   | A new object containing only explicitly selected fields from a larger payload.                             |
| Transpile            | Convert source code from one language to another, here TypeScript to JavaScript.                           |
| Webhook              | A URL that another service calls to tell us something happened (Meta calls ours on messages).              |
