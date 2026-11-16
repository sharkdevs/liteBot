# Chapter 4 - Phase 3: Persistence Layer

Chapter 3 connected the webhook to a worker through a BullMQ queue. A message
existed only as a job in Redis, and the job disappeared after its retention
limit. This phase makes **PostgreSQL the source of truth**: before a message is
queued, the webhook saves the sender, their conversation, and the message
itself in the database.

```text
Webhook
    |
Persist Message
    |
Queue Job
    |
Worker
```

At the end of Phase 3, the worker still only logged jobs. There was no AI, no
outbound WhatsApp message, and no business rule such as "start a new conversation
after 24 hours". Phase 4 later adds AI response generation and stores its result;
it still does not send WhatsApp messages. A conversation row represents a
**WhatsApp conversation**, not a session the application invents (section 3).
The goal here is to understand durable storage before anything depends on it.

By the end of this chapter you should understand:

1. What a source of truth is, and why a queue is not one.
2. What PostgreSQL, the Prisma schema, Prisma Migrate, Prisma Client, and a
   driver adapter each do.
3. The three tables, how they relate, and why each column has its type and
   constraints.
4. What a WhatsApp conversation is, how little Meta tells us about it today,
   and why future AI memory will be a separate concept.
5. What a migration is, which command to use when, and how to add a required
   column to a table that already has rows.
6. How the repository pattern and a unit of work keep database code out of the
   controller.
7. What a transaction is, and how a lock prevents a real race condition.
8. How a redelivered message is recognized, and why a message ID from a
   different sender is refused.
9. How to see the saved rows yourself.
10. What this phase deliberately does **not** guarantee yet.

---

## 1. Why a database, when we already have a queue?

### Operational state versus durable state

| Store      | Kind of state   | What it holds here                              | How long                                  | Built for                              |
| ---------- | --------------- | ----------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Redis      | **Operational** | Queued jobs, their status, retries              | Until processed and trimmed (latest 1000) | Fast coordination of work in progress  |
| PostgreSQL | **Durable**     | Users, conversations, and every inbound message | Until we deliberately delete it           | Keeping facts safely and querying them |

**Operational state** describes work in progress: "this job is waiting", "this
job failed twice". It is useful now and can be thrown away later. **Durable
state** describes facts the business depends on: "this person sent this message
in this conversation". It must survive restarts, crashes, and deployments.

The **source of truth** is the one place whose answer wins when stores disagree.
From this phase on, that is PostgreSQL. A Redis job is a _notification_ that a
saved message needs processing; it is no longer the only copy of the message.

### Why durable storage is needed even with a queue

1. **Jobs are temporary by design.** BullMQ keeps only the latest 1000 completed
   and 1000 failed jobs, then deletes older ones. A queue answers "what work is
   left?", not "what has this person said?". The next phase's worker needs the
   conversation history, and a queue cannot provide it.
2. **Our Redis can lose recent data.** The Compose Redis saves periodic
   snapshots, not every write (Chapter 3, section 12). PostgreSQL records each
   change in its
   [write-ahead log](https://www.postgresql.org/docs/current/wal-intro.html)
   and flushes it to permanent storage when the transaction commits, so a crash
   can be recovered from.
3. **Facts have relationships and rules.** A message belongs to a conversation,
   which belongs to a user. The database enforces this with foreign keys, and
   enforces "one user per phone number" with a unique constraint. Redis has no
   such guarantees.
4. **Duplicates must be recognized forever.** Meta may deliver the same message
   more than once. With the message's WhatsApp ID stored permanently, a
   redelivery is recognized next week as well as in the next second.
5. **We can query and audit.** "Show this person's last 20 messages" is one
   indexed query in PostgreSQL. Answering it from Redis job data would be slow,
   incomplete, and fragile.

### Why save first, then queue

The order matters. Compare the two possibilities when something fails halfway:

| Order                      | If the second step fails                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue first, then save     | The worker may process a message the database has never heard of. The source of truth is missing a fact that the system already acted on.         |
| **Save first, then queue** | The request returns `500`, Meta retries, the save step recognizes the message as already saved, and this time the job is queued. Nothing is lost. |

So every job refers to a message that is already stored. Section 8 shows how the
retry is recognized.

## 2. The new tools

### PostgreSQL

[PostgreSQL](https://www.postgresql.org/docs/current/) is a **relational
database**. Data lives in **tables**; each table has **columns** (named, typed
fields) and **rows** (records). Programs talk to it in SQL. It has run in
Docker Compose since the bootstrap stage, and this is the first phase that
connects to it.

### Prisma, in four pieces

[Prisma ORM](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
was installed during bootstrap. This phase uses all of it:

| Piece              | File or folder                          | What it does                                                                                     |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Prisma schema**  | `prisma/schema.prisma`                  | Describes our models (tables), fields (columns), and relations in one readable file.             |
| **Prisma Migrate** | `prisma/migrations/`                    | Turns schema changes into SQL **migration** files and applies them to a database (section 4).    |
| **Prisma Client**  | `src/generated/prisma/` (not committed) | Generated TypeScript whose methods and types match the schema, such as `prisma.user.findUnique`. |
| **Driver adapter** | `@prisma/adapter-pg`                    | Prisma 7's bridge to PostgreSQL, using the `pg` (node-postgres) driver and its connection pool.  |

`prisma.config.ts` tells the Prisma **CLI** (the `prisma` command) where the
schema and migrations are and which database URL to use. The running
application does not read it; it builds its own client in
`src/config/database.ts` (section 9).

### Connections are opened lazily

Creating a `PrismaClient` does not connect. The first query opens a connection
from the pool. That is why the API starts, and `/health` answers `200`, even
when PostgreSQL is down; only the first database query fails.

We also set `connectionTimeoutMillis: 5000`. By default node-postgres
[waits forever](https://node-postgres.com/apis/pool) for a new connection
("By default this is 0 which means no timeout"), which could leave a webhook
request hanging. With the timeout, the request fails and returns `500`, and Meta
retries later.

## 3. The data model

Three tables, each with a one-to-many relationship to the next:

```text
users
  id                         PK
  phone_number               unique
  created_at
  updated_at
      │
      │ one user has many conversations
      ▼
conversations
  id                         PK
  user_id                    FK → users.id
  whatsapp_conversation_id   unique, nullable  ┐
  category                   nullable          │ WhatsApp metadata:
  origin_type                nullable          │ filled in only when Meta reports it
  expires_at                 nullable          ┘
  started_at
  created_at
  updated_at
      │
      │ one conversation has many messages
      ▼
messages
  id                         PK
  conversation_id            FK → conversations.id
  whatsapp_message_id        unique, nullable
  direction                  INBOUND | OUTBOUND
  content
  created_at
```

- A **user** has many **conversations**; each conversation belongs to one user.
- A **conversation** has many **messages**; each message belongs to one
  conversation.

**PK** means **primary key**: the column that uniquely identifies a row. **FK**
means **foreign key**: a column that must hold the primary key of a row in
another table. The database refuses a message whose `conversation_id` does not
exist.

In the schema, these relations are written as a field on each side:

```prisma
model Conversation {
  id       String    @id @default(uuid(7)) @db.Uuid
  userId   String    @map("user_id") @db.Uuid
  user     User      @relation(fields: [userId], references: [id])
  messages Message[]
  // ...
}
```

`user` and `messages` are **relation fields**: they exist in Prisma Client (for
example, to load a user's conversations), but not as database columns. Only
`userId` is a real column. See
[Prisma relations](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations).

### Field by field

**`users`**

| Field (TypeScript) | Column         | Type               | Notes                                                     |
| ------------------ | -------------- | ------------------ | --------------------------------------------------------- |
| `id`               | `id`           | `uuid`             | Primary key, a UUIDv7 generated by Prisma Client          |
| `phoneNumber`      | `phone_number` | `text`, **unique** | The sender's WhatsApp number (`from`), e.g. `15550000001` |
| `createdAt`        | `created_at`   | `timestamptz(3)`   | Set by the database when the row is inserted              |
| `updatedAt`        | `updated_at`   | `timestamptz(3)`   | Set by Prisma Client on every create and update           |

**`conversations`**

| Field (TypeScript)       | Column                     | Type                         | Notes                                                                    |
| ------------------------ | -------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `id`                     | `id`                       | `uuid`                       | Primary key                                                              |
| `userId`                 | `user_id`                  | `uuid`                       | Foreign key to `users.id`                                                |
| `whatsappConversationId` | `whatsapp_conversation_id` | `text`, **unique**, nullable | Meta's `conversation.id`, when Meta sends one                            |
| `category`               | `category`                 | `text`, nullable             | Meta's `pricing.category`, such as `service`                             |
| `originType`             | `origin_type`              | `text`, nullable             | Meta's `conversation.origin.type`, such as `service`                     |
| `expiresAt`              | `expires_at`               | `timestamptz(3)`, nullable   | Meta's `conversation.expiration_timestamp`                               |
| `startedAt`              | `started_at`               | `timestamptz(3)`             | The WhatsApp `timestamp` of the first message stored in the conversation |
| `createdAt`              | `created_at`               | `timestamptz(3)`             | When we inserted the row; used to find a user's **latest** conversation  |
| `updatedAt`              | `updated_at`               | `timestamptz(3)`             | Not yet changed when messages arrive                                     |

**`messages`**

| Field (TypeScript)  | Column                | Type                         | Notes                                                                 |
| ------------------- | --------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `id`                | `id`                  | `uuid`                       | Primary key; also used as the BullMQ job ID (section 8)               |
| `conversationId`    | `conversation_id`     | `uuid`                       | Foreign key to `conversations.id`                                     |
| `whatsappMessageId` | `whatsapp_message_id` | `text`, **unique**, nullable | Meta's ID (`wamid...`); recognizes redeliveries                       |
| `direction`         | `direction`           | enum `message_direction`     | `INBOUND` (from the person) or `OUTBOUND` (from the assistant, later) |
| `content`           | `content`             | `text`                       | The message text; private data                                        |
| `createdAt`         | `created_at`          | `timestamptz(3)`             | When we saved it, not Meta's `timestamp`                              |

### Why these choices

**Names: camelCase in code, snake_case in the database.** TypeScript convention
is `phoneNumber`; SQL convention is `phone_number`. `@map` (columns) and `@@map`
(tables and the enum) give each side its usual style.

**IDs are UUIDv7, not 1, 2, 3.** A
[UUID](https://www.rfc-editor.org/rfc/rfc9562.html) is a 128-bit identifier
such as `01a1e601-cae6-7361-a8f6-eddbf972a528`.

- It can be created anywhere, without asking the database for the next number.
  That matters later, when several regions write data.
- It does not reveal how many users or messages exist.
- Version 7 starts with a timestamp, so new IDs sort roughly by creation time.
  This keeps index inserts efficient, unlike fully random version 4 UUIDs.

`@default(uuid(7))` is supported by the
[Prisma schema reference](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference).
Prisma Client generates the value; the migration has **no** database default
for `id`. A row inserted with hand-written SQL must supply its own ID.

**Times are `timestamptz(3)`.** PostgreSQL's `timestamp with time zone`
[stores an absolute instant](https://www.postgresql.org/docs/current/datatype-datetime.html)
(internally UTC), so a time saved by a server in one region means the same
moment in every other region. `(3)` keeps millisecond precision, the same
precision as a JavaScript `Date`.

**`phone_number` is unique.** One person, one `users` row. The database rejects a
second row with the same number, even if our code had a bug.

**`whatsapp_message_id` is unique but optional.** Unique, so the same WhatsApp
message can never be stored twice. Optional (`String?`, nullable), because an
outbound reply only receives Meta's ID after it is sent, in a later phase.
PostgreSQL treats NULLs as
[not equal to each other](https://www.postgresql.org/docs/current/ddl-constraints.html)
in a unique constraint, so many messages can have no ID yet.
`whatsapp_conversation_id` follows the same rule: unique, so one WhatsApp
conversation is stored once, and nullable, so the many conversations Meta has
not identified can coexist.

**`category` and `origin_type` are text, not enums.** Meta lists the values it
sends today, and adds new ones over time. A PostgreSQL enum would reject an
unknown value, so a new Meta category would make a save fail. We store Meta's
raw string instead. The two fields also use different spellings for some values
(`authentication-international` in `pricing.category`,
`authentication_international` in `origin.type`), so they are kept separately and
unchanged.

**`started_at` and `created_at` are different clocks.** `started_at` is
WhatsApp's `timestamp` for the first message we stored in the conversation.
`created_at` is when our server inserted the row, which can be much later, for
example if Meta retried the delivery for an hour.

**Foreign keys use `ON DELETE RESTRICT ON UPDATE CASCADE`.** These are
[Prisma's defaults for required relations](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations/referential-actions).
`RESTRICT` means a user who still has conversations cannot be deleted, so
history is never removed by accident. `CASCADE` on update would copy a changed
ID to the related rows, but our IDs never change.

**Two indexes, one per real query.** An **index** is a sorted lookup structure
that lets the database find rows without reading the whole table. PostgreSQL
indexes primary keys and unique columns automatically, but
[not foreign key columns](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK).
So we added:

| Index                                      | Serves                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| `conversations (user_id, created_at DESC)` | "Find this user's latest conversation" (this phase)           |
| `messages (conversation_id, created_at)`   | "Load this conversation's messages in order" (the next phase) |

Each also speeds up the foreign key checks on its first column.

### A conversation is WhatsApp's, not ours

A `conversations` row represents a **WhatsApp conversation**: something Meta
defines and reports. The application never decides where one conversation ends
and the next begins. There is no inactivity window ("a new conversation after
30 minutes of silence") and no business rule ("a new conversation per support
ticket").

What does Meta actually tell us about conversations? Less than you might expect.
We checked Meta's webhook reference while building this phase:

1. **Inbound messages carry no conversation information.** A text message
   webhook has `from`, `id`, `timestamp`, `type`, and `text`, plus optional
   fields such as `context` (the message being replied to) and `referral` (the
   ad the user tapped), but no conversation ID, category, or expiry
   ([text message webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text)).
   Inbound messages are all this phase receives.
2. **Conversation data comes only with status updates for messages the business
   sends.** A **status webhook** reports that a message _we_ sent was `sent`,
   `delivered`, or `read`. Only those can include a `conversation` object
   (`id`, `expiration_timestamp`, `origin.type`) and a `pricing` object (which
   includes `category`), and only with `sent` and one of `delivered` or `read`.
   `expiration_timestamp` is included only with `sent`
   ([status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)).
3. **WhatsApp no longer bills by conversation.** On July 1, 2025, Meta replaced
   conversation-based pricing, where a conversation was a 24-hour billing
   period, with **per-message pricing**
   ([pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).
   As a result, from Graph API v24.0 the `conversation` object is "omitted
   entirely" unless the message was sent inside an open **free entry point**
   window, and its ID is then unique per window. In v23.0 and lower,
   `conversation.id` is a new ID for every message unless such a window is open.

A **free entry point window** opens when someone messages a business from a
Click to WhatsApp ad and the business replies within the customer service
window. It can stay open for up to 7 days, during which Meta does not charge
for most of the business's messages
([pricing: free entry point window](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#free-entry-point-window-fep)).

The **customer service window** is a different rule: every message from the
user starts or resets a 24-hour timer, and while it runs the business may send
any message type; afterwards only approved templates
([customer service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows)).
It limits what we may send. It is not a conversation, and this phase does not
model it.

What this means for our data:

- **The WhatsApp columns are NULL today, on purpose.** Every conversation
  created in this phase has no `whatsapp_conversation_id`, `category`,
  `origin_type`, or `expires_at`, because no webhook we process carries them.
  We never guess a value.
- **A user's messages all join their latest conversation.** Since an inbound
  message names no conversation, the service attaches it to the user's latest
  one and creates a conversation only for a user who has none. `started_at` is
  then that first message's WhatsApp `timestamp`.
- **Enrichment comes later.** Once the assistant sends replies, a later phase
  can process status webhooks and fill in the WhatsApp columns. That needs a
  repository method to update a conversation, which is not added yet because
  nothing would call it. That phase must also pin Graph API v24.0 or later, or
  ignore per-message IDs: storing a v23 per-message `conversation.id` as a
  conversation ID would make every reply look like a new conversation.

### WhatsApp conversations versus AI memory (assistant threads)

Once the assistant answers questions, it will need **memory**: the context the
AI model sees, such as recent messages, a summary of older ones, or facts about
the user. It is tempting to reuse `conversations` for that, starting a new
conversation when the topic changes or the history grows too long. We
deliberately will not.

|                      | WhatsApp conversation (`conversations`)               | AI memory or assistant thread (future, if needed)               |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Defined by           | Meta                                                  | Us: product and AI design decisions                             |
| Purpose              | Mirror what WhatsApp reports, such as category/expiry | Give the model the context it needs for a good answer           |
| Boundaries come from | WhatsApp's data in webhooks                           | Our rules: topic changes, token budgets, a user asking to reset |
| Holds                | WhatsApp metadata; the messages belong to it          | Summaries, selected messages, remembered facts                  |
| Changes when         | Meta reports new data                                 | We change how the assistant remembers                           |

If one table served both purposes, every row would mean two different things.
WhatsApp's boundaries and ours would conflict, and every change to the AI's
memory strategy would rewrite the record of what happened on WhatsApp.

So if memory needs its own state, a later phase will add a **separate concept**,
for example an `assistant_threads` table that belongs to a user and refers to
the messages or summaries it uses. The next phase may not need it at all:
loading the user's most recent messages from `messages` may be enough context
to start with.

## 4. Migrations: changing the database safely

A **migration** is a SQL file that moves a database from one version of the
schema to the next. Migrations are committed to git, so every database (yours,
the tests', production's) can be brought to exactly the same shape.

This phase adds two:

```text
prisma/migrations/
├── migration_lock.toml                                    records the provider (postgresql)
├── 20261116194416_create_users_conversations_messages/
│   └── migration.sql                                      CREATE TYPE, CREATE TABLE, indexes, foreign keys
└── 20261116210018_add_whatsapp_conversation_metadata/
    └── migration.sql                                      the WhatsApp conversation columns (below)
```

An excerpt of the first:

```sql
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_number" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
-- ...
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");
```

Prisma records each applied migration in a table called `_prisma_migrations`,
so it knows what is still pending.

### Which command, when

| Command                         | Runs                    | Use it to                                                                       |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `npm run prisma:migrate:deploy` | `prisma migrate deploy` | Apply committed migrations. Setup, tests, and production use this.              |
| `npm run prisma:migrate`        | `prisma migrate dev`    | **Development only:** create a new migration after you change the schema.       |
| `npm run prisma:generate`       | `prisma generate`       | Regenerate Prisma Client after the schema changes (also run by `npm run build`) |

`migrate deploy` only applies existing files. `migrate dev` compares the schema
with the migration history, writes a new migration if they differ, applies it,
and may offer to **reset** (empty) your development database if the history and
database disagree. Prisma's
[development and production guide](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production)
warns never to use `migrate dev` in production.

**Prisma 7 does not regenerate the client during migrations.** The
[v7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) says
`migrate dev` and `db push` "no longer run `prisma generate` automatically". The
development-and-production page still lists client generation as a `migrate dev`
step, so the two official pages disagree. We tested Prisma 7.10.1: `migrate dev`
created and applied a migration in a throwaway database but generated no client.
Run `npm run prisma:generate` yourself after any schema change.

Two rules for the future:

- **Never edit a migration that has been applied anywhere.** Change the schema
  and create a new migration instead.
- **Migrations are not applied automatically when the API starts.** Applying
  them is a deliberate step, so a deployment can never change the database by
  surprise.

### The second migration: a required column on a table with rows

The WhatsApp conversation columns arrived after the first migration had already
been applied to development databases. Following the first rule above, they are
a second migration rather than an edit to the first.

Four of the new columns are nullable, which is easy: existing rows simply get
NULL. `started_at` is required (`NOT NULL`), and existing rows have no value for
it. Prisma generated this:

```sql
ALTER TABLE "conversations" ADD COLUMN     "category" TEXT,
-- ...
ADD COLUMN     "started_at" TIMESTAMPTZ(3) NOT NULL,
-- ...
```

On a table that already has a row, PostgreSQL refuses that statement. We ran it
on a throwaway database holding one conversation:

```text
ERROR:  column "started_at" of relation "conversations" contains null values
```

Our own development database happened to be empty, but yours may not be, and
production never is.

Prisma's guide to
[customizing migrations](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/customizing-migrations)
covers this: create the migration as a **draft**, edit its SQL, then apply it.
The committed file does it in three steps:

```sql
ALTER TABLE "conversations" ADD COLUMN ... "started_at" TIMESTAMPTZ(3), ...;   -- 1. nullable

UPDATE "conversations" SET "started_at" = "created_at";                          -- 2. backfill

ALTER TABLE "conversations" ALTER COLUMN "started_at" SET NOT NULL;            -- 3. required
```

A **backfill** fills a new column for rows that existed before it. We used each
conversation's `created_at`: the conversation was created in the same
transaction as its first message, so that is the closest value we have. (Meta's
timestamp for that message was not stored.) On the throwaway database the
migration succeeded, and the existing row's `started_at` equaled its
`created_at`.

**How the draft was made.** Prisma's documented command is
`npm run prisma:migrate -- --name add_whatsapp_conversation_metadata --create-only`,
which writes the migration folder without applying it. Use that in your own
terminal. The automation tool we used runs commands without an interactive
terminal, and `migrate dev` refuses to run there:

```text
Error: Prisma Migrate has detected that the environment is non-interactive, which is not supported.
```

So we produced the same SQL with
[`prisma migrate diff`](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference#migrate-diff),
which only reads and prints:

```powershell
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

This compares the database in `DATABASE_URL`, which had exactly the first
migration applied, with the edited schema. We saved the output in a new folder
named with the current UTC time, edited it as above, and applied it with
`npm run prisma:migrate:deploy`. Diffing from the migrations folder instead
(`--from-migrations`) would need a `shadowDatabaseUrl` in `prisma.config.ts`,
which we have not set.

To confirm the database now matches the schema:

```powershell
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
# No difference detected.
```

**If you set up Phase 3 before this migration existed,** pull, run
`npm run prisma:generate` and `npm run prisma:migrate:deploy`, then restart the
API.

## 5. Following one message end to end

```text
Meta POST /webhook
   |
parseWebhookPayload() validates the whole batch           --> 400 if malformed
   |
WebhookController picks the supported text messages
   |
for each one, in order:
   ConversationService.recordInboundMessage()
      one database transaction, locked per sender (section 7):
         find the user by phone number
         is this WhatsApp message ID already saved?        --> yes: reuse its IDs (section 8)
         create the user if missing
         find the latest conversation; create one if missing
            (started_at = the message's WhatsApp timestamp; WhatsApp metadata NULL)
         save the INBOUND message
      commit                                               --> 500 if PostgreSQL fails
   |
IncomingMessageQueue.enqueue(jobs)                         --> 500 if Redis fails
   (job ID = the message's database ID)
   |
200 OK

            ...later, in the worker process...

Worker logs the job with userId, conversationId, and messageId
```

The steps inside the transaction are the prompt's webhook flow: find user,
create if missing, find latest conversation, create if missing, save the
message. The duplicate check is the one addition, explained in section 8.

The job now carries the database IDs:

```ts
interface IncomingMessageJob {
  correlationId: string;
  messageId: string; // our database ID; also the BullMQ job ID
  userId: string;
  conversationId: string;
  whatsappMessageId: string; // Meta's ID (wamid...)
  phoneNumber: string;
  messageText: string;
  timestamp: string; // Meta's Unix time in seconds, as text
}
```

## 6. Repositories, the unit of work, and dependency injection

### The layers

```text
WebhookController       HTTP: validate, pick messages, call the service, enqueue, answer
      │ depends on IConversationService
      ▼
ConversationService     The steps: find or create user and conversation, save message
      │ depends on IUnitOfWork
      ▼
PrismaUnitOfWork        One transaction plus a lock; hands out repositories
      │ creates
      ▼
UserRepository, ConversationRepository, MessageRepository
      │ use
      ▼
Prisma Client  ──▶  PostgreSQL
```

Each arrow points to an **interface**, not a concrete class, except at the
bottom where something has to talk to the database.

### The repository pattern

A **repository** is an object that gives the rest of the application
collection-like access to stored data ("find the user with this phone number",
"create this message") while hiding _how_ it is stored. Martin Fowler's
[catalog entry](https://martinfowler.com/eaaCatalog/repository.html) describes
the pattern.

The prompt asked for these methods:

| Repository               | Requested                     | Added, and why                                                                  |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------- |
| `UserRepository`         | `findByPhoneNumber`, `create` |                                                                                 |
| `ConversationRepository` | `findLatestForUser`, `create` | `findById`: confirm which user owns an already-saved message (section 8)        |
| `MessageRepository`      | `create`                      | `findByWhatsappMessageId`: recognize a message Meta delivered again (section 8) |

Each file has an interface (`IUserRepository`) and a class (`UserRepository`).
The class is the only place that knows the Prisma query, for example:

```ts
findLatestForUser(userId: string): Promise<Conversation | null> {
  return this.db.conversation.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
```

The second `orderBy` breaks a tie if two conversations were created in the same
millisecond, so the answer is always the same.

Repositories return **domain types** from `src/domain/`, such as `User` and
`Message`. These are plain TypeScript interfaces that do not import Prisma.
Code above the repositories never needs Prisma's generated types, so the
database library could be replaced without touching the service or controller.

### The unit of work

Creating a user, a conversation, and a message is one logical action. If the
third step fails, the first two must not remain. A **unit of work** groups
several repository calls into one database **transaction** (see Fowler's
[unit of work](https://martinfowler.com/eaaCatalog/unitOfWork.html)).

```ts
interface IUnitOfWork {
  runExclusive<T>(lockKey: string, work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
```

`PrismaUnitOfWork.runExclusive` starts a Prisma
[interactive transaction](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions#interactive-transactions),
takes a lock (section 7), and gives `work` a set of repositories that all use
that transaction. When `work` finishes, the transaction **commits** (all changes
become permanent together). If it throws, the transaction **rolls back** (none of
its changes are kept).

This is why repositories receive a `DatabaseClient` in their constructor instead
of creating Prisma themselves: the same class works with the full client or with
one transaction's client.

### Dependency injection and the composition root

No class creates its own dependencies. `src/server.ts` builds everything once and
passes each object to the next through its constructor:

```ts
const prisma = createPrismaClient(env.databaseUrl, logger);
// ...
conversationService: new ConversationService(new PrismaUnitOfWork(prisma), logger),
```

The place where this wiring happens is called the **composition root**. The
benefits:

- **Tests choose the parts.** The webhook unit tests inject a small fake
  `IConversationService` and need no database. The persistence tests inject a
  unit of work whose message save fails on purpose, to prove the rollback.
- **NestJS-ready.** NestJS's dependency injection container does the same wiring
  automatically from constructor parameters, so these classes can move there
  later with little change.
- **SOLID.** The controller depends on abstractions (dependency inversion), each
  class has one reason to change (single responsibility), and each interface is
  small (interface segregation).

## 7. Transactions and a race condition

### The race

Imagine a new person sends "Hi" and then "Are you there?" a moment later. Meta
can deliver them as two separate webhook requests at nearly the same time, and
with several API instances, they can be handled in parallel. Without
coordination:

```text
time   request A ("Hi")                      request B ("Are you there?")
 1     find user 1555... → none
 2                                           find user 1555... → none
 3     create user                  ✔
 4                                           create user          ✘ unique violation → 500
```

Here the unique constraint on `phone_number` saved us from two users, but
request B failed. Worse, **nothing in the database limits a user to one
conversation**: if the user already existed, both requests could see "no
conversation" and create one each, splitting one chat into two.

This is a **race condition**: the result depends on the exact timing of two
operations that both read and then write.

### The fix: one sender at a time

`runExclusive` takes a PostgreSQL
[advisory lock](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
as its first statement:

```ts
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
```

- An **advisory lock** is a lock on a number whose meaning the application
  decides. PostgreSQL does not attach it to any table.
- `pg_advisory_xact_lock` is the **transaction-level** form: it waits until no
  other transaction holds the same number, and it is released automatically when
  the transaction commits or rolls back. There is no unlock call to forget.
- The service uses the key `sender:<phone number>`. `hashtextextended(text, 0)`
  is a built-in PostgreSQL function that turns that text into the 64-bit number
  the lock needs. It is **not described in the PostgreSQL manual** (a search of
  the documentation finds nothing); we checked that it exists and returns a
  `bigint` on our PostgreSQL 18. We rely on it only to turn text into a number.

The result: messages from the **same** sender are saved one after another;
messages from **different** senders do not wait for each other. Request B now
waits at the lock until A commits, then finds the user and conversation A
created.

Two different phone numbers could, very rarely, hash to the same number. The only
effect would be that those two senders wait for each other briefly. Data is never
wrong because of it.

### Why this is enough at the default isolation level

PostgreSQL's default isolation level is
[Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED):
each statement sees the data committed before that statement began. Because B's
queries run only after A has committed and released the lock, B's queries see
A's rows. A stricter isolation level is not needed.

Why not simply catch the unique violation and retry, or use an "upsert"
(insert-or-update)? That would solve the user race but not the conversation
race, because "the latest conversation" is not something a unique constraint can
express. The lock protects the whole find-or-create sequence.

### Evidence

The integration test "simultaneous first messages from one sender create one
user and one conversation" saves five messages from one new number in parallel.
With the lock line removed, it failed with a unique violation on
`users_phone_number_key`. With the lock, it passes: one user, one conversation,
five messages.

### Time limits

Prisma's interactive transactions have defaults of `maxWait` 2 seconds (to get a
connection) and `timeout` 5 seconds (for the whole transaction, including any
time spent waiting for the lock). If either is exceeded, the transaction rolls
back and the request returns `500`, so Meta retries.

## 8. Duplicates, and a bug found by hand

### Recognizing a redelivery

Meta can deliver the same message more than once (Chapter 3, section 1). Inside
the transaction, the service first looks for a message with the same WhatsApp
message ID:

- **Not found:** continue as normal and save it.
- **Found, same sender:** save nothing, log `Inbound message already saved`, and
  return the **same** `userId`, `conversationId`, and `messageId` as the first
  time.

Because the IDs are the same, the job is the same too. The queue uses the
message's database ID as the BullMQ **job ID**, and BullMQ
[ignores an add whose job ID already exists](https://docs.bullmq.io/guide/jobs/job-ids).
So a redelivery saves nothing new and queues nothing new.

There are two layers, with different lifetimes:

| Layer                                   | Protects against                     | Lasts                                                                 |
| --------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| PostgreSQL unique `whatsapp_message_id` | Storing the same message twice       | Forever                                                               |
| BullMQ job ID = `messageId`             | Queuing the same saved message twice | Only while the job is kept in Redis (latest 1000 completed or failed) |

Caveats of the queue layer:

- `Incoming message queued` is logged even when BullMQ ignored the add, because
  the add call returns normally either way.
- After a job has been trimmed from Redis, a later redelivery is queued again.
  Processing must become idempotent in later phases, before it sends replies.
- A redelivery whose earlier job **failed** and is still kept is not queued again;
  that job stays failed until someone retries or removes it.
- BullMQ job IDs must not contain `:` and must not be only digits. UUIDs satisfy
  both rules.

### The bug: one message ID, two senders

While running the "Run it yourself" experiments by hand (section 11), we reused a
synthetic message ID from an earlier run but changed the sender's number. The
first version of the service checked for a duplicate **after** finding or
creating the user. So it:

1. created a new user and an empty conversation for the new number,
2. then found the existing message, which belonged to the **other** sender,
3. and returned the new user's ID together with the other sender's conversation
   and message IDs.

The logs and the job carried IDs that did not belong together. Every automated
test had used a fresh message ID per sender, so none had covered this.

A real WhatsApp message ID identifies one message from one sender, so the same ID
arriving from a different number can only come from a forged or hand-written
request. The fix:

1. Look for the message ID **before** creating anything.
2. If it exists, load its conversation (`ConversationRepository.findById`) and
   check that the conversation belongs to this sender.
3. If it does not, throw `WhatsappMessageIdConflictError`
   ([`message-id-conflict.error.ts`](../src/domain/message/message-id-conflict.error.ts)).
   The transaction rolls back, nothing is saved, and the error middleware returns
   a generic `500`.

The regression test "a message ID already saved for another sender is refused
without saving anything" failed before the fix ("Missing expected rejection") and
passes after it. It checks both a brand-new sender and an existing one.

If two _different_ senders submit the same new ID at the same instant, they take
different locks. The unique constraint then acts as the final safety net: one
transaction fails with a unique violation and returns `500`.

The lesson repeats Chapter 3's: hand-run experiments with slightly "wrong" input
find bugs that tests written from the happy path do not.

## 9. The new code, file by file

### `prisma/schema.prisma` and `prisma/migrations/`

The models and both migrations (sections 3 and 4).

### `prisma.config.ts`

It now reads `process.env['DATABASE_URL']` instead of Prisma's strict `env()`
helper, and passes a URL only when one is set. `prisma generate` needs no
database, so `npm run prisma:generate` and `npm run build` (which runs
`prisma generate` first) work without a `.env`; commands that connect, such as
`prisma migrate deploy`, still report a missing URL.

### `src/domain/`

| File                                   | Contents                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| `user/user.ts`                         | `User` and `NewUser` (what you supply to create one)                  |
| `conversation/conversation.ts`         | `Conversation`, `NewConversation`, and `WhatsappConversationMetadata` |
| `message/message.ts`                   | `Message`, `NewMessage`, and the `MessageDirection` values            |
| `message/message-id-conflict.error.ts` | `WhatsappMessageIdConflictError` (section 8)                          |

`WhatsappConversationMetadata` groups the four fields Meta may report. Every one
is `string | null` or `Date | null`, so code that reads a conversation has to
handle "not known yet".

### `src/config/database.ts`

`createPrismaClient(databaseUrl, logger)` builds the `PrismaPg` adapter (with the
5-second connection timeout and error logging) and a `PrismaClient` that uses it.
It also exports `DatabaseClient`, the type repositories accept.

### `src/config/env.ts`

`loadApiEnv()` now requires `DATABASE_URL` and checks that it starts with
`postgresql://` or `postgres://`. The error message never repeats the value,
because a connection string contains a password. `loadWorkerEnv()` does not
require it: the worker does not use the database yet.

### `src/repositories/`

The three repositories and `unit-of-work.ts` (sections 6 and 7).

### `src/services/conversation.service.ts`

`ConversationService.recordInboundMessage()` runs the steps in section 5 inside
`runExclusive('sender:' + phoneNumber, ...)`. It logs only **after** the
transaction commits, so a log line never describes a row that was rolled back.
It returns `{ userId, conversationId, messageId, duplicate }`.

### `src/controllers/webhook.controller.ts`

The controller now receives an `IConversationService`. After validating the
batch and choosing the supported text messages, it saves them one at a time,
in order, builds a job from each result, and then enqueues all of them. If any
save fails, the error reaches the error middleware (`500`) and **nothing** is
queued for that request. It converts Meta's `timestamp` (Unix seconds, as text)
to a `Date` for the service, which uses it as a new conversation's
`startedAt`; the job keeps the original text.

### `src/shared/utils/unix-time.ts` and `webhook-validation.ts`

`isUnixSecondsString` and `unixSecondsToDate` validate and convert Meta's
timestamps. Converting exposed a gap: the validator accepted any whole number
up to `Number.MAX_SAFE_INTEGER`, but a JavaScript `Date` only reaches
8,640,000,000,000 seconds, the year 275760
([ECMAScript time range](https://tc39.es/ecma262/#sec-time-values-and-time-range)).
A larger value would have produced an invalid `Date` (its time is `NaN`). The
validator now rejects it with `400`, and a webhook unit test proves it.

### `src/queues/message.queue.ts` and `src/workers/message.worker.ts`

The producer passes `{ jobId: data.messageId }` to `queue.add`, and both sides log
the new IDs. The worker's behavior is otherwise unchanged.

### `src/app.ts` and `src/server.ts`

`createApp` takes a `conversationService`. `server.ts` creates the Prisma client
and wires the service. On shutdown, after closing the HTTP server and the queue,
it disconnects Redis and then calls `prisma.$disconnect()`.

### `package.json`

| Script                  | Change                                                |
| ----------------------- | ----------------------------------------------------- |
| `build`                 | Now runs `prisma generate` before compiling           |
| `prisma:migrate`        | New: `prisma migrate dev`                             |
| `prisma:migrate:deploy` | New: `prisma migrate deploy`                          |
| `test:integration`      | Now also runs `tests/persistence.integration.test.ts` |

No dependencies were added; Prisma and the adapter were installed during
bootstrap.

## 10. Logs: new lines and a renamed field

### New log lines

| Message                         | Level | Fields                                                                        |
| ------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `User created`                  | info  | `correlationId`, `userId`                                                     |
| `Existing user found`           | debug | `correlationId`, `userId`                                                     |
| `Conversation created`          | info  | `correlationId`, `userId`, `conversationId`                                   |
| `Latest conversation found`     | debug | `correlationId`, `userId`, `conversationId`                                   |
| `Inbound message saved`         | info  | `correlationId`, `userId`, `conversationId`, `messageId`, `whatsappMessageId` |
| `Inbound message already saved` | info  | the same fields as `Inbound message saved`                                    |

`Incoming message queued` and every worker log now also include `userId`,
`conversationId`, `messageId`, and `whatsappMessageId`. The two `debug` lines
appear only with `LOG_LEVEL=debug`.

### A renamed field

| Field               | Phase 2 meaning                | Phase 3 meaning                |
| ------------------- | ------------------------------ | ------------------------------ |
| `messageId`         | Meta's message ID (`wamid...`) | **Our** database ID (a UUID)   |
| `whatsappMessageId` | _(did not exist)_              | Meta's message ID (`wamid...`) |

When searching logs from before and after this change, remember that the same
name changed meaning. The new names match the database columns, so a log value
can be pasted straight into a SQL query.

### A real run

Captured with `LOG_LEVEL=debug`, trimmed to the interesting fields. The first
request is a new sender; the second is the identical payload again; the third is
a new message from the same sender:

```text
API     User created                      correlationId=local-demo-1  userId=01a1e601-cae6-...
API     Conversation created              correlationId=local-demo-1  userId=01a1e601-cae6-...  conversationId=01a1e601-caff-...
API     Inbound message saved             correlationId=local-demo-1  messageId=01a1e601-cb04-...  whatsappMessageId=wamid.local-persist-1
API     Incoming message queued           correlationId=local-demo-1  jobId=01a1e601-cb04-...  messageId=01a1e601-cb04-...
API     Inbound message already saved     correlationId=local-demo-1-again  messageId=01a1e601-cb04-...  (same IDs as above)
API     Incoming message queued           correlationId=local-demo-1-again  jobId=01a1e601-cb04-...  (BullMQ ignored it)
API     Existing user found               correlationId=local-demo-2  userId=01a1e601-cae6-...
API     Latest conversation found         correlationId=local-demo-2  conversationId=01a1e601-caff-...
API     Inbound message saved             correlationId=local-demo-2  messageId=01a1e601-db2d-...  whatsappMessageId=wamid.local-persist-2
API     Incoming message queued           correlationId=local-demo-2  jobId=01a1e601-db2d-...  messageId=01a1e601-db2d-...
Worker  Incoming message processing started    correlationId=local-demo-1  jobId=01a1e601-cb04-...  userId=...  conversationId=...  attempt=1
Worker  Incoming message processing completed  correlationId=local-demo-1  jobId=01a1e601-cb04-...
Worker  Incoming message processing started    correlationId=local-demo-2  jobId=01a1e601-db2d-...  attempt=1
Worker  Incoming message processing completed  correlationId=local-demo-2  jobId=01a1e601-db2d-...
```

The worker processed two jobs, not three: the redelivery was recognized. The
message text appeared in none of the logs.

## 11. Run it yourself

You need Docker Desktop running and a `WHATSAPP_VERIFY_TOKEN` in `.env` (see the
[README](../README.md#generate-your-verification-token)). `DATABASE_URL` in
`.env.example` already matches the Compose database.

**One-time setup** (also needed after pulling a new migration):

```powershell
docker compose up -d --wait        # PostgreSQL and Redis
npm run prisma:generate            # Prisma Client for this schema
npm run prisma:migrate:deploy      # create the tables
```

**Terminal 1:** `npm run dev` (API). **Terminal 2:** `npm run dev:worker`.

### Experiment A: the first message creates three rows

In **terminal 3**, post the same synthetic payload as Chapter 3:

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
          "id": "wamid.local-persist-1",
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
$post = { param($body, $id) Invoke-WebRequest -Method Post -Uri 'http://localhost:3000/webhook' `
  -ContentType 'application/json' -Headers @{ 'x-correlation-id' = $id } -Body $body }
(& $post $payload 'local-demo-1').StatusCode     # 200
```

Terminal 1 logs `User created`, `Conversation created`, `Inbound message saved`,
and `Incoming message queued`. Now look at the database:

```powershell
docker compose exec postgres psql -U litebot -d litebot -c "SELECT id, phone_number, created_at FROM users;"
docker compose exec postgres psql -U litebot -d litebot -c "SELECT id, user_id, started_at, whatsapp_conversation_id, category, origin_type, expires_at, created_at FROM conversations;"
docker compose exec postgres psql -U litebot -d litebot -c "SELECT id, conversation_id, whatsapp_message_id, direction, created_at FROM messages ORDER BY created_at;"
```

Each `id` should match the IDs in the logs. The conversation's `started_at` is
`2026-01-01 00:00:00+00`, the payload's `timestamp` (`1767225600`), while
`created_at` is the moment you posted. The four WhatsApp columns are empty:
an inbound message carries no conversation data (section 3). The queries leave
out `content` deliberately; it holds the message text, which in real use is
private.

### Experiment B: Meta delivers it again

```powershell
(& $post $payload 'local-demo-1-again').StatusCode     # 200
```

The API logs `Inbound message already saved` with the same IDs. Re-run the
`messages` query: still one row. The worker does not process anything new.

### Experiment C: a second message reuses the user and conversation

This message has a new ID and is dated one week later (`1767830400` is
2026-01-08):

```powershell
$second = $payload -replace 'local-persist-1', 'local-persist-2' -replace '1767225600', '1767830400'
(& $post $second 'local-demo-2').StatusCode     # 200
```

With `LOG_LEVEL=debug` you also see `Existing user found` and
`Latest conversation found`. The `messages` query now shows two rows with the
same `conversation_id`, and the `conversations` query still shows one row with
`started_at` unchanged: a week of silence does not start a new conversation,
because only WhatsApp defines conversations.

### Experiment D: the same message ID from a different sender

```powershell
$forged = $payload -replace '15550000001', '15550000009'
try { & $post $forged 'local-demo-conflict' } catch { [int]$_.Exception.Response.StatusCode }   # 500
```

The API logs `Unexpected request error` with `WhatsappMessageIdConflictError`.
The `users` query shows no row for `15550000009`.

### Experiment E: PostgreSQL is unavailable

```powershell
docker compose stop postgres
```

`GET /health` still returns `200`: it is a liveness check only. Posting a
**new** message ID returns `500`, and the API logs
`PrismaClientKnownRequestError: Can't reach database server`. Nothing is queued,
because saving comes first. If the pool still held an idle connection when
PostgreSQL stopped, the API also logs `PostgreSQL idle connection error`
(`terminating connection due to administrator command`); that line is
informational, and the API keeps running. Start PostgreSQL again with
`docker compose up -d --wait postgres`; the next POST succeeds without restarting
the API, because the pool opens a fresh connection.

### Cleaning up

These statements delete only the synthetic senders used above, children first
(the foreign keys require that order):

```powershell
docker compose exec postgres psql -U litebot -d litebot -c "DELETE FROM messages WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN users u ON u.id = c.user_id WHERE u.phone_number IN ('15550000001', '15550000009'));"
docker compose exec postgres psql -U litebot -d litebot -c "DELETE FROM conversations WHERE user_id IN (SELECT id FROM users WHERE phone_number IN ('15550000001', '15550000009'));"
docker compose exec postgres psql -U litebot -d litebot -c "DELETE FROM users WHERE phone_number IN ('15550000001', '15550000009');"
```

Completed jobs stay in Redis until the retention limit trims them. To erase all
local data instead, `docker compose down -v` deletes both volumes.

## 12. Automated tests

| Command                    | Needs                | Covers                                                                                    |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `npm test`                 | Nothing              | Startup, configuration, and webhook HTTP behavior with a fake service and in-memory queue |
| `npm run test:integration` | Redis and PostgreSQL | Real BullMQ (Chapter 3) and real persistence (below)                                      |

### A throwaway database for every run

The persistence tests never touch your development data.
[`tests/support/test-database.ts`](../tests/support/test-database.ts):

1. connects to PostgreSQL using `TEST_DATABASE_URL` (default: the Compose
   database on `127.0.0.1:5432`),
2. creates a new database named `litebot_test_<random hex>`,
3. applies the committed migrations with `prisma migrate deploy`, which also
   proves both migrations work on an empty database,
4. drops the database with `DROP DATABASE ... WITH (FORCE)` when the tests end.

### What the tests prove

Persistence integration tests (real PostgreSQL):

| Test                                                                                      | Proves                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A first message creates a user, a conversation, and an inbound message                    | All three rows and their links; `startedAt` is the message's timestamp; WhatsApp metadata is NULL; logs carry the IDs but no text or phone |
| A later message reuses the user and their latest conversation                             | Thirteen days later: one user, one conversation with `startedAt` unchanged, two messages                                                   |
| A redelivered message is saved once and returns the same IDs                              | Duplicate recognition                                                                                                                      |
| A message ID already saved for another sender is refused without saving anything          | The section 8 bug stays fixed                                                                                                              |
| Simultaneous first messages from one sender create one user and one conversation          | The advisory lock (section 7)                                                                                                              |
| A failure while saving the message rolls back the user and conversation                   | The transaction is all-or-nothing, and nothing is logged                                                                                   |
| `findLatestForUser` returns the most recently created conversation                        | Ordering by `createdAt`, not insertion order                                                                                               |
| A conversation stores WhatsApp metadata, and one WhatsApp conversation ID maps to one row | The metadata columns round-trip, and the unique constraint rejects a second row with the same ID                                           |
| A webhook request saves the message, then a worker consumes its job                       | The whole path, job contents, worker logs, and a duplicate POST                                                                            |

Added elsewhere:

- Queue integration: "enqueueing the same saved message twice keeps one job".
- Webhook unit tests: messages are saved and then enqueued with their database
  IDs, and the service receives the message's timestamp as a `Date`; a save
  failure returns `500` and enqueues nothing; invalid batches (including a
  timestamp beyond the `Date` range) and unsupported events are neither saved
  nor queued.
- Configuration: the API accepts a PostgreSQL `DATABASE_URL` and rejects others
  without echoing them; the worker does not need one.

```powershell
docker compose up -d --wait
npm test
npm run test:integration
node --import tsx --test --test-name-pattern="simultaneous" tests/persistence.integration.test.ts
npm run typecheck; npm run lint; npm run format:check; npm run build
```

## 13. Honest limits of this phase

**POSTs are still unauthenticated, and now they write to the database.** Anyone
who can reach `/webhook` can create users and messages. Meta signature
verification (`X-Hub-Signature-256`) is required before real traffic.

**Personal data is now stored durably.** Phone numbers and message text are in
PostgreSQL, message text is in Redis jobs, and phone numbers appear in webhook,
queue, and worker logs. There is no retention or deletion policy yet. Use
synthetic data only.

**A batch can be partly saved.** Each message is saved in its own transaction.
If the third message of a batch fails, the first two stay saved, nothing is
queued, and the request returns `500`. Meta's retry then recognizes the first two
as duplicates and queues all three.

**A message can be saved but never queued.** If Redis rejects the job after the
save, the request returns `500` and relies on Meta's retry. If Meta stopped
retrying (after about 7 days), the message would stay saved but unprocessed.
Nothing sweeps for such messages yet; a common fix is the **transactional
outbox** pattern, where the "to be queued" record is written in the same
transaction as the message.

**Queue deduplication is temporary.** As section 8 explains, it lasts only while
the job is kept in Redis.

**The job's text is a copy.** A forged redelivery with the same message ID and
sender but different text returns the saved message's IDs while its job carries
the new text. The database keeps the original. The next phase's worker should
load the message from PostgreSQL by `messageId` rather than trust the job's text.

**The WhatsApp conversation columns stay empty.** Inbound messages carry no
conversation data, and nothing processes status webhooks yet, so
`whatsapp_conversation_id`, `category`, `origin_type`, and `expires_at` are
NULL in every row. Until then a user's messages all join their latest
conversation: the most recently _created_ one, which in practice is their only
one. `Conversation.updatedAt` does not change when a message arrives.

**Senders without a phone number are skipped.** Meta omits `from` when a user
has adopted a WhatsApp username and their phone number is not available to the
business, and recommends identifying users by a business-scoped user ID
(`from_user_id`) instead
([text message webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text)).
Such a message is logged as `missing_phone_number` and neither saved nor
queued. Supporting it means identifying `users` by that ID as well as by phone
number.

**A refused message ID returns a generic `500`.** Meta never sends a conflicting
ID, so this only affects forged or hand-written requests.

**`/health` does not check PostgreSQL.** It is still a liveness check.

## 14. What comes next

Phase 4 builds on these stored rows: the worker reads recent history, calls an
abstract AI provider, and saves an `OUTBOUND` response. See
[Chapter 5 - AI Integration](05-ai-integration.md) for the prompt, provider, and
worker details.

Later work can add authenticated webhook deliveries, a Redis-backed conversation
cache if needed, WhatsApp sending, status-webhook processing for WhatsApp
conversation metadata (section 3), and idempotent response processing. AI memory
would remain separate from WhatsApp `Conversation` if recent messages are not
enough (section 3). After the end-to-end flow works, revisit automatic worker
startup and scaling
([Chapter 3, section 13](03-queue-infrastructure.md#13-who-starts-the-worker-automatic-scaling-is-deferred)).

**Previous:** [Chapter 3 - Queue Infrastructure (Phase 2)](03-queue-infrastructure.md)

**Next:** [Chapter 5 - AI Integration (Phase 4)](05-ai-integration.md)

## Official references

- [Prisma: schema overview](https://www.prisma.io/docs/orm/v7/prisma-schema/overview)
- [Prisma: relations](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations)
- [Prisma: referential actions and their defaults](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations/referential-actions)
- [Prisma: schema reference (`uuid(7)`, `@map`, `@updatedAt`)](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference)
- [Prisma: transactions (interactive transactions and their time limits)](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)
- [Prisma: getting started with Prisma Migrate](https://www.prisma.io/docs/orm/v7/prisma-migrate/getting-started)
- [Prisma: Migrate in development and production](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production)
- [Prisma: Migrate mental model](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/mental-model)
- [Prisma: customizing migrations (draft, edit, apply)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/customizing-migrations)
- [Prisma: CLI reference, `migrate diff`](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference#migrate-diff)
- [Prisma: upgrade guide to v7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [Prisma: database connections](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections)
- [Prisma: adding Prisma to an existing PostgreSQL project (driver adapter)](https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/postgresql)
- [PostgreSQL: constraints (unique, foreign keys)](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL: date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html)
- [PostgreSQL: indexes](https://www.postgresql.org/docs/current/indexes-intro.html)
- [PostgreSQL: explicit locking and advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- [PostgreSQL: advisory lock functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL: write-ahead logging](https://www.postgresql.org/docs/current/wal-intro.html)
- [node-postgres: pool options](https://node-postgres.com/apis/pool)
- [BullMQ: job IDs](https://docs.bullmq.io/guide/jobs/job-ids)
- [WhatsApp: text message webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text)
- [WhatsApp: status webhook reference (`conversation` and `pricing` objects)](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)
- [WhatsApp: pricing (per-message pricing, free entry point window)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [WhatsApp: conversation-based pricing (deprecated)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing)
- [WhatsApp: customer service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows)
- [ECMAScript: time values and time range](https://tc39.es/ecma262/#sec-time-values-and-time-range)
- [RFC 9562: UUIDs, including version 7](https://www.rfc-editor.org/rfc/rfc9562.html)
- [Martin Fowler: Repository](https://martinfowler.com/eaaCatalog/repository.html) and [Unit of Work](https://martinfowler.com/eaaCatalog/unitOfWork.html)
