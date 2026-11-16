# Chapter 1 — Bootstrap

**Goal of this stage:** create a clean foundation that installs, compiles, runs,
and answers `GET /health` with `200 OK`. No WhatsApp, AI, or queue features yet.

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

Every package is the latest stable release, pinned exactly (no `^`) so that
`npm install` produces the same result for everyone. Three deliberate
exceptions or changes from the original request:

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
it directly, so we cannot remove it without patching BullMQ. It is harmless on
modern Node.js and will disappear when BullMQ drops it.

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
  It checks `src/` and `prisma.config.ts`, and never writes files (`noEmit`).
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

Variables for later stages (Redis, WhatsApp, Azure OpenAI) are listed in
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
method, URL, status code, and response time.

---

## 6. Following a request to `GET /health`

Files: `src/server.ts`, `src/app.ts`, `src/routes/health.route.ts`.

```text
curl http://localhost:3000/health
        │
        ▼
 server.ts   createApp().listen(3000)      ← the process is listening
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

Other details in `app.ts`:

- `app.disable('x-powered-by')` removes a header advertising Express, which
  would only help attackers.
- CORS is **not** enabled. CORS controls which _websites_ may call the API from
  a browser. Our caller is Meta's servers, not browsers, and `cors()` with no
  options would allow every website. It will be enabled with an explicit list
  of allowed origins if a browser client is ever added.
- Unknown URLs return Express's default `404`. A consistent JSON error format
  arrives with the error-handling middleware in a later stage.

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

With Docker Desktop running:

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d --wait
npm run prisma:generate
npm run typecheck; npm run lint; npm run format:check; npm run build
npm run dev
```

In another terminal:

```powershell
curl http://localhost:3000/health          # → {"status":"healthy"}
npx prisma migrate status                  # connects; reports no migrations yet
docker compose exec redis redis-cli ping   # → PONG
```

What was verified for this stage:

| Check                         | Result                                       |
| ----------------------------- | -------------------------------------------- |
| `npm install`                 | Succeeded; 0 vulnerabilities                 |
| `docker compose up --wait`    | `postgres` and `redis` healthy               |
| `npm run prisma:generate`     | Client generated to `src/generated/prisma`   |
| `npx prisma migrate status`   | Connected to PostgreSQL; no migrations yet   |
| typecheck, lint, format       | All pass                                     |
| `npm run build` + `npm start` | `GET /health` → `200 {"status":"healthy"}`   |
| `npm run dev`                 | `GET /health` → `200`; unknown route → `404` |

---

## 11. Deliberately left for later

Each item has a `TODO` in the code or an empty folder kept with `.gitkeep`:

- Database models and migrations (`User`, `Conversation`, `Message`).
- Correlation IDs on every request and in every log line.
- Centralised error middleware with a consistent JSON error format.
- An automated test runner and HTTP tests.
- The WhatsApp webhook, BullMQ queue and worker, Azure OpenAI provider, and
  Redis conversation cache.
- The health response's final shape, which will add
  `"service": "whatsapp-ai-assistant"`.

**Next:** Chapter 2 — Data model _(coming in Stage 2)_.
