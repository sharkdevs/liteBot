-- Generated with `prisma migrate diff`, then edited by hand: the generated SQL added
-- "started_at" as NOT NULL in one step, which fails on a table that already has rows.
-- The column is added as nullable, backfilled, and only then made NOT NULL.
-- See https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/customizing-migrations

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "category" TEXT,
ADD COLUMN     "expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "origin_type" TEXT,
ADD COLUMN     "started_at" TIMESTAMPTZ(3),
ADD COLUMN     "whatsapp_conversation_id" TEXT;

-- Backfill: an existing conversation was created in the same transaction as its first
-- message, so its creation time is the closest value we have to when it started.
UPDATE "conversations" SET "started_at" = "created_at";

ALTER TABLE "conversations" ALTER COLUMN "started_at" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "conversations_whatsapp_conversation_id_key" ON "conversations"("whatsapp_conversation_id");
