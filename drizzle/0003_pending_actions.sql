CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'task.create' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "pending_actions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pending_actions_type_check" CHECK ("pending_actions"."type" = 'task.create'),
	CONSTRAINT "pending_actions_status_check" CHECK ("pending_actions"."status" IN ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired')),
	CONSTRAINT "pending_actions_attempts_check" CHECK ("pending_actions"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "pending_actions_payload_check" CHECK (jsonb_typeof("pending_actions"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pending_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "pending_actions_tenant_isolation" ON "pending_actions" AS PERMISSIVE FOR ALL TO "analytics_ro", "app_user" USING ("pending_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("pending_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);