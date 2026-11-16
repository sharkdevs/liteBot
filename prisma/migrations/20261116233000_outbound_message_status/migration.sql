CREATE TYPE "message_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

ALTER TABLE "messages"
    ADD COLUMN "status" "message_status",
    ADD COLUMN "reply_to_message_id" UUID;

-- Phase 4 replies were stored but never sent. Inbound delivery status is not applicable.
UPDATE "messages"
SET "status" = CASE
    WHEN "whatsapp_message_id" IS NULL THEN 'PENDING'::"message_status"
    ELSE 'SENT'::"message_status"
END
WHERE "direction" = 'OUTBOUND';

CREATE UNIQUE INDEX "messages_reply_to_message_id_key" ON "messages"("reply_to_message_id");
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey"
    FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
