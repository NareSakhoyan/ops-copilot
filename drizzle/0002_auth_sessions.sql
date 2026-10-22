ALTER TABLE "audit_logs" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "used_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "refresh_tokens_tenant_family_idx" ON "refresh_tokens" USING btree ("tenant_id","family_id");