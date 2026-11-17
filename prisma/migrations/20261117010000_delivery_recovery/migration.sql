ALTER TYPE "message_status" ADD VALUE 'UNKNOWN';
ALTER TABLE "messages" ADD COLUMN "dispatch_correlation_id" TEXT;
ALTER TABLE "users" ADD COLUMN "next_whatsapp_send_at" TIMESTAMPTZ(3);

-- Only newly authenticated work receives dispatch intent; legacy replies remain untouched.
CREATE INDEX "messages_pending_dispatch_idx" ON "messages" ("id")
WHERE "status" = 'PENDING' AND "dispatch_correlation_id" IS NOT NULL;
