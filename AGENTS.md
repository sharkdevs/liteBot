# Project Goal

Build a production-quality starter backend for a WhatsApp AI assistant. It should begin as a small proof of concept while keeping clear boundaries so it can evolve into a distributed, multi-region system.

**These are target requirements, not a description of what this repository currently implements.** Do not assume a listed component or behavior exists until you verify it in the code.

## Target Stack

- Node.js 22+ and strict TypeScript
- Express
- PostgreSQL with Prisma and migrations
- Redis with BullMQ for jobs and conversation caching
- Azure OpenAI behind an AI-provider interface
- WhatsApp Cloud API behind a provider interface
- Docker Compose for local PostgreSQL and Redis
- Pino for logging

## Architecture Boundaries

Keep the system organized into distinct API, queue, domain, infrastructure, and worker layers. The webhook layer should stay thin; business processing should happen asynchronously in workers. Abstract database operations behind repositories and providers behind interfaces. Design dependencies so dependency injection and a future NestJS migration are possible.

The intended source organization is:

```text
src/
├── app.ts
├── server.ts
├── config/
├── routes/
├── controllers/
├── domain/
├── services/
├── providers/
├── repositories/
├── queues/
├── workers/
├── middleware/
└── shared/
```

## Functional Requirements

- `GET /health` returns `{"status":"healthy","service":"whatsapp-ai-assistant"}`.
- `GET /webhook` supports Meta verification using an environment-provided verification token.
- `POST /webhook` authenticates Meta's signature over the raw body, validates inbound events, persists messages, enqueues work, and responds promptly.
- An AI worker loads conversation history, builds a prompt, calls the AI provider, saves the response, and publishes an outgoing job.
- A separate WhatsApp worker consumes outgoing jobs and calls the WhatsApp provider. Never send WhatsApp messages directly from the AI worker.
- Persist authenticated dispatch intent with the reply and recover missed publications. Serialize and pace sends per recipient across replicas. Never automatically resend an uncertain acceptance; require explicit reconciliation.
- Define an `IAiProvider.generateResponse(userMessage, conversationHistory)` method and an Azure OpenAI implementation injected through its constructor.
- Model `User` (`id`, `phoneNumber`, `createdAt`), `Conversation` (`id`, `userId`, `createdAt`, `updatedAt`), and `Message` (`id`, `conversationId`, `direction`, `content`, `createdAt`); message direction is `INBOUND` or `OUTBOUND`.
- Add a cache-service abstraction for Redis-backed conversation caching.

## Cross-Cutting Requirements

- Provide `.env.example` with configuration for the server port, database, Redis, WhatsApp, and Azure OpenAI.
- Attach an `x-correlation-id` to every request. Include `correlationId`, `userId`, and `conversationId` in relevant logs where available.
- Use centralized error middleware. Do not use `console.log`.
- Use async/await, avoid `any`, and follow SOLID and the repository pattern.
- Include ESLint and Prettier configuration.
- Document architecture, local setup, environment variables, worker startup, and a scalability roadmap in the README.

## Scalability Roadmap

Document the path from Express + BullMQ + PostgreSQL toward Azure Front Door, Kafka or Event Hubs, multi-region workers, Redis Cluster, and a globally distributed database.

When implementing this goal, make focused changes, preserve these layer boundaries, and verify behavior with the repository's available checks.
