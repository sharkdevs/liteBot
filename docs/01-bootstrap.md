# Chapter 1 — Bootstrap

**Goal of this stage:** create a clean foundation that installs, compiles, runs,
and answers `GET /health` with `200 OK`. No WhatsApp, AI, or queue features yet.

This chapter records the bootstrap stage. The current code also includes
[Phase 1: Webhook Foundation](02-webhook-foundation.md), which adds a required
verification token, injected dependencies, webhook routes, and error middleware.

By the end of this chapter you should understand:

1. What each tool in the project does and why it was chosen.
2. How TypeScript source becomes running JavaScript.
3. What happens, step by step, when someone calls `GET /health`.
4. How configuration and logging work.
5. How PostgreSQL and Redis run locally, and how Prisma connects to them.

---

## 1. The big picture

A Node.js backend is a long-running program that listens on a network port and
answers HTTP requests. Ours is written in **TypeScript**, a version of JavaScript
with types, so mistakes such as passing a number where text is expected are
caught before the program runs.

```text
 Your code (TypeScript, src/)
        │
        │  development: tsx runs it directly
        │  production:  tsc compiles it to dist/, then node runs it
        ▼
 Node.js process ── listens on PORT ──▶ answers HTTP requests
        │
        ├── reads settings from .env (dotenv)
        └── writes JSON logs (Pino)

 Docker Compose (separately) runs PostgreSQL and Redis in containers.
 Prisma reads prisma/schema.prisma and generates a typed database client.
```

Stage 1 sets all of this up, but only the HTTP part does real work.

---

## 2. Tools and why each exists

### Runtime dependencies (needed when the app runs)

| Package              | Role                                                         | Used yet? |
| -------------------- | ------------------------------------------------------------ | --------- |
| `express`            | Receives HTTP requests and routes them to handler functions. | Yes       |
| `dotenv`             | Loads variables from the `.env` file into `process.env`.     | Yes       |
| `pino`               | Fast logger that writes one JSON object per line.            | Yes       |
| `pino-http`          | Express middleware that logs every request with Pino.        | Yes       |
| `@prisma/client`     | Runtime library used by the generated Prisma client.         | Stage 2   |
| `@prisma/adapter-pg` | Connects Prisma 7 to PostgreSQL using the `pg` driver.       | Stage 2   |
| `bullmq`             | Job queue stored in Redis; lets workers process jobs later.  | Later     |
| `redis`              | Redis client, for the conversation cache.                    | Later     |
| `openai`             | Official SDK; supports Azure OpenAI.                         | Later     |
| `uuid`               | Generates unique IDs.                                        | Later     |
| `cors`               | Controls which websites' browsers may call the API.          | Later     |

### Development dependencies (needed only while building)

| Package                                                | Role                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `typescript`                                           | The compiler (`tsc`): type-checks code and outputs JavaScript.         |
| `tsx`                                                  | Runs TypeScript directly and restarts on file changes (`npm run dev`). |
| `prisma`                                               | Command-line tool: generates the client, and later creates migrations. |
| `@types/node`, `@types/express`, `@types/cors`         | Type descriptions for libraries written in JavaScript.                 |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | Linting, including rules that use type information.                    |
| `prettier`, `eslint-config-prettier`                   | Automatic formatting; the config stops ESLint arguing with Prettier.   |

### Version choices

Direct dependencies use stable versions checked on 2026-11-16 and are pinned
exactly (no `^`). `package-lock.json` also records transitive dependencies
(packages used by our dependencies); `npm ci` installs that locked tree.
Three deliberate exceptions or changes from the original request:

1. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint` 8.72.2, the latest,
   supports TypeScript below 6.1. Choosing 7 would mean dropping typed linting.
   We will upgrade when `typescript-eslint` supports TypeScript 7.
2. **Prisma 7.10.1, not 8.0.0-rc.33.** Prisma's `latest` npm tag currently
   points to a release candidate. We use the newest _stable_ release.
3. **`tsx` instead of `ts-node-dev`.** `ts-node-dev` was last released in 2022
   and pulls in deprecated sub-packages. `tsx` is actively maintained and does
   the same job: run TypeScript and restart on change.

**Known deprecation warning:** `npm install` reports `node-abort-controller`
as deprecated. It is a dependency of BullMQ 6.7.6 (the latest), which imports
it directly. All direct dependencies are non-deprecated, but the complete tree
is **not deprecation-free**. Retaining the requested current BullMQ version
retains this upstream warning; we have not patched or hidden it.

**Audit result:** `npm audit --omit=dev` reports zero runtime vulnerabilities.
The full `npm audit` reports seven moderate entries stemming from a single
[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) in the
typescript-eslint dependency chain. These are not seven separate flaws.
The affected code handles glob-pattern preprocessing, not HTTP requests.
In this repository the parser receives the fixed `eslint.config.js` pattern
from our lint configuration and does not enable the affected optimization mode.
The advisory is deferred for this development-only use; no high or critical
findings were reported. We have not forced a major-version override or downgraded
the agreed lint toolchain just to remove the warning. Recheck on 2026-11-23 or
when typescript-eslint publishes a compatible fix, whichever is first.

Node.js must satisfy `^22.13.0 || >=24.0.0`. Although Prisma supports 22.12,
ESLint requires at least 22.13 on Node 22.

---

## 3. How TypeScript becomes a running program

Files: `package.json`, `tsconfig.json`, `tsconfig.build.json`.

### ES modules

`package.json` contains `"type": "module"`. That tells Node.js to treat `.js`
files as **ES modules**, the modern standard that uses `import` and `export`.
Many current packages (for example `uuid` 14 and the Prisma 7 client) are built
for ES modules first.

One visible consequence: imports of our own files end in `.js`, even though the
source file is `.ts`:

```ts
import { logger } from './config/logger.js';
```

This looks odd at first. Node.js runs the _compiled_ files, which are `.js`,
and it requires exact file names. TypeScript understands that `./logger.js`
refers to `logger.ts` while you are editing. This behaviour is selected by
`"module": "NodeNext"` and `"moduleResolution": "NodeNext"` in `tsconfig.json`.
(The original request mentioned `moduleResolution: node`; that setting is
deprecated for modern Node.js and does not understand ES modules correctly.)

### Two TypeScript configurations

- **`tsconfig.json`** — used by your editor, `npm run typecheck`, and ESLint.
  It checks `src/`, `tests/`, and `prisma.config.ts`, and never writes files (`noEmit`).
- **`tsconfig.build.json`** — used by `npm run build`. It extends the first
  file, then sets `rootDir: src` and `outDir: dist`, so `src/app.ts` becomes
  `dist/app.js`.

### Strictness settings

`strict: true` turns on TypeScript's core safety checks, including
`noImplicitAny` (every value must have a known type). We add a few more:

| Option                       | What it catches                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`   | `list[5]` might be `undefined`; you must handle that case.                         |
| `exactOptionalPropertyTypes` | Distinguishes "property missing" from "property set to `undefined`".               |
| `noImplicitOverride`         | Requires `override` when a subclass replaces a parent method.                      |
| `noFallthroughCasesInSwitch` | Stops a `switch` case accidentally running into the next one.                      |
| `verbatimModuleSyntax`       | Type-only imports must be marked `import type`, so they vanish cleanly at runtime. |

### Development versus production

| Mode        | Command         | What happens                                                         |
| ----------- | --------------- | -------------------------------------------------------------------- |
| Development | `npm run dev`   | `tsx watch` runs `src/server.ts` directly and restarts on each save. |
| Production  | `npm run build` | `tsc` type-checks and writes JavaScript to `dist/`.                  |
|             | `npm start`     | Plain `node dist/server.js`; no TypeScript tooling at runtime.       |

`tsx` skips type-checking to stay fast, so run `npm run typecheck` (or rely on
your editor) to see type errors during development.

---

## 4. Configuration: `src/config/env.ts`

Settings that differ between machines (ports, passwords, URLs) live in
**environment variables**, not in code. Locally, those come from a `.env` file
that you create by copying `.env.example`. `.gitignore` excludes `.env` so
secrets are never committed.

`env.ts` does three things:

1. `import 'dotenv/config'` reads `.env` and fills `process.env`. Real
   environment variables (for example, set by a hosting platform) take
   precedence over the file.
2. It **validates** the values it needs now: `PORT` must be a whole number from
   1 to 65535, and `LOG_LEVEL` must be a valid Pino level. Invalid values stop
   the app at start-up with a clear error, instead of failing mysteriously later.
3. It exports a frozen, typed `env` object. Other code reads `env.port`
   rather than touching `process.env` directly, so all configuration has one
   entry point.

Phase 1 additionally requires a non-empty `WHATSAPP_VERIFY_TOKEN`. Variables for
later stages (Redis, WhatsApp sending, Azure OpenAI) are listed in
`.env.example` but are not validated yet; each will be validated in the stage
that starts using it.

---

## 5. Logging: `src/config/logger.ts`

The app never uses `console.log` (ESLint's `no-console` rule enforces this).
Instead it uses **Pino**, which writes **structured logs**: one JSON object per
line.

```json
{
  "level": 30,
  "time": 1794827986247,
  "service": "whatsapp-ai-assistant",
  "port": 3000,
  "msg": "HTTP server listening"
}
```

- `level` is numeric: 30 = info, 40 = warn, 50 = error.
- `service` is added to every line, so logs from many services can be told
  apart once they are collected in one place.
- Extra context is passed as an object: `logger.info({ port }, 'message')`.

Because each line is JSON, log tools can filter by any field, for example
"all errors for conversation X". Later stages add `correlationId`, `userId`,
and `conversationId` to exactly this kind of log line.

`pino-http` (added in `app.ts`) writes one line per completed request with the
method, URL path, status code, and response time. Phase 1 removes query strings
and request headers from those logs so the verification token cannot leak.
`server.ts` now calls `createLogger(env.logLevel)` and injects that shared logger
into `createApp`, rather than having application modules load global configuration.

---

## 6. Following a request to `GET /health`

Files: `src/server.ts`, `src/app.ts`, `src/routes/health.route.ts`.

```text
curl http://localhost:3000/health
        │
        ▼
 server.ts   app.listen(3000)             ← app was built with injected config/logger
        │
        ▼
 app.ts      pinoHttp        ← starts timing; will log when the response ends
             express.json()  ← would parse a JSON body (none on a GET)
             healthRouter    ← matches GET /health
        │
        ▼
 health.route.ts   res.status(200).json({ status: 'healthy' })
        │
        ▼
 pino-http logs: GET /health → 200 in a few ms
```

Why are `app.ts` and `server.ts` separate?

- **`app.ts`** _builds_ the Express application: which middleware and routes
  exist. `createApp()` returns it without opening a network port, so later
  stages can test the app in memory.
- **`server.ts`** _runs_ it: opens the port, logs start-up, and handles shutdown.

### Startup failures

An occupied port is not a successful startup. In
[Express 5](https://expressjs.com/en/guide/migrating-5/#applisten), `listen()`
passes binding errors to its callback. `server.ts` checks that argument, logs
the error through Pino, and sets exit code `1` instead of claiming to be listening.
An exit code of `0` means success to a shell or process supervisor, so this
distinction matters even for a minimal server.

Other details in `app.ts`:

- `app.disable('x-powered-by')` removes a header advertising Express, which
  would only help attackers.
- CORS is **not** enabled. CORS controls which _websites_ may call the API from
  a browser. Our caller is Meta's servers, not browsers, and `cors()` with no
  options would allow every website. It will be enabled with an explicit list
  of allowed origins if a browser client is ever added.
- Unknown URLs return Express's default `404`. Phase 1 adds consistent JSON
  responses for malformed requests (`400`) and unexpected failures (`500`).

### Graceful shutdown

When you press Ctrl+C (`SIGINT`) or a platform stops the app (`SIGTERM`),
`server.ts` calls `server.close()`. That stops accepting new connections but
lets in-flight requests finish before the process exits. Later, the same hook
will close database and Redis connections.

---

## 7. Local infrastructure: `docker-compose.yml`

Instead of installing PostgreSQL and Redis on your computer, Docker runs each
in a **container**. `docker compose up -d --wait` starts both in the background
and waits until they are healthy.

| Service    | Image                | Port   | Stores data in volume |
| ---------- | -------------------- | ------ | --------------------- |
| `postgres` | `postgres:18-alpine` | `5432` | `postgres-data`       |
| `redis`    | `redis:8-alpine`     | `6379` | `redis-data`          |

- **Volumes** keep data when containers are restarted. `docker compose down -v`
  deletes them for a clean start.
- **Health checks** (`pg_isready`, `redis-cli ping`) tell Docker when each
  service is actually ready, not merely started.
- The PostgreSQL user, password, and database are all `litebot`. These are
  development-only credentials and match `DATABASE_URL` in `.env.example`.
- Port mappings bind to `127.0.0.1`, so these local services are not published
  to other computers on the network. Do not use this unauthenticated Redis or
  the example PostgreSQL password for a deployment.

---

## 8. Prisma: `prisma/schema.prisma` and `prisma.config.ts`

**Prisma** is an ORM. You describe tables in `schema.prisma`; Prisma then
creates the database tables (through migrations) and _generates_ a TypeScript
client whose methods and types match those tables exactly.

Prisma 7 splits configuration into two files:

- **`prisma.config.ts`** tells the Prisma CLI where the schema and migrations
  live, and reads `DATABASE_URL`. It imports `dotenv/config` because Prisma 7
  no longer loads `.env` automatically.
- **`prisma/schema.prisma`** has two blocks and, for now, no tables:
  - `generator client` uses the `prisma-client` generator, which writes
    plain TypeScript into `src/generated/prisma`. That folder is generated, so
    it is excluded from git, ESLint, and Prettier. Re-create it with
    `npm run prisma:generate`.
  - `datasource db` says the database is PostgreSQL.

At runtime (from Stage 2), the app will connect using a **driver adapter**,
`@prisma/adapter-pg`, which is Prisma 7's way of talking to PostgreSQL.

---

## 9. Code quality: ESLint and Prettier

- **Prettier** decides formatting (quotes, commas, line width) so nobody has to.
  Settings: `.prettierrc.json`; skipped paths: `.prettierignore`.
- **ESLint** (`eslint.config.js`) finds likely bugs. It uses
  `strictTypeChecked` from typescript-eslint, which asks TypeScript about types
  and can, for example, spot a forgotten `await` or a disallowed `any`.
  `no-console` is an error to enforce structured logging.

---

## 10. Verify it yourself

The bootstrap tests use Node's built-in test runner, with `tsx` loading TypeScript.
`npm test` now also includes the webhook tests added in Phase 1:

```powershell
npm test
node --import tsx --test --test-name-pattern="occupied port" tests/bootstrap.test.ts
```

The health test opens an ephemeral (OS-selected) port and checks the exact
Stage 1 response. The startup test reserves a port, starts a second process
on that port, and requires an error log and exit code `1`. It failed before
the startup fix because the process exited successfully. A Phase 1 regression
also checks rejection of an unconfigured token. Tests clean up their listeners
and need no database, Redis, or external API credentials.

With Docker Desktop running:

```powershell
npm ci
Copy-Item .env.example .env
# Set WHATSAPP_VERIFY_TOKEN in .env (required since Phase 1).
docker compose up -d --wait
npm run prisma:generate
npm run typecheck; npm run lint; npm run format:check; npm run build
npm run dev
```

In another terminal:

```powershell
curl http://localhost:3000/health          # → {"status":"healthy"}
docker compose exec redis redis-cli ping   # → PONG
docker compose exec postgres pg_isready -U litebot -d litebot
```

`npx prisma migrate status` can also confirm connectivity, but an empty schema
with no migration history reports an unmanaged database and exits nonzero.
That is expected in Stage 1; it is not a passing migration check. Do not create
a dummy model or migration to silence it.

What was verified for this stage:

| Check                         | Result                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `npm ci`                      | Succeeded; see dependency warnings above                     |
| `npm audit --omit=dev`        | Zero runtime vulnerabilities                                 |
| `npm audit`                   | Seven moderate dev-tool entries; deferred as explained above |
| `npm test`                    | Health and occupied-port regression tests pass               |
| `docker compose up --wait`    | `postgres` and `redis` healthy                               |
| `npm run prisma:generate`     | Client generated to `src/generated/prisma`                   |
| `pg_isready` / Redis `ping`   | PostgreSQL accepts connections; Redis returns `PONG`         |
| typecheck, lint, format       | All pass                                                     |
| `npm run build` + `npm start` | `GET /health` → `200 {"status":"healthy"}`                   |
| `npm run dev`                 | `GET /health` → `200`; unknown route → `404`                 |

---

## 11. How the project evolves from here

Phase 1 now supplies the webhook controller, runtime validation, centralized
error middleware, and webhook HTTP tests. Still outside the current implementation:

- Database models and migrations (`User`, `Conversation`, `Message`).
- Correlation IDs on every request and in every log line.
- POST signature authentication and broader database/worker tests.
- The BullMQ queue and worker, Azure OpenAI provider, and
  Redis conversation cache.
- The health response's final shape, which will add
  `"service": "whatsapp-ai-assistant"`.

**Next:** [Chapter 2 — Webhook Foundation (Phase 1)](02-webhook-foundation.md).
