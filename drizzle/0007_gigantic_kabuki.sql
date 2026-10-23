CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	CONSTRAINT "chunks_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "chunks_document_ordinal_unique" UNIQUE("tenant_id","document_id","ordinal"),
	CONSTRAINT "chunks_ordinal_check" CHECK ("chunks"."ordinal" > 0)
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"allowed_roles" text[] NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	CONSTRAINT "documents_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "documents_tenant_source_unique" UNIQUE("tenant_id","source"),
	CONSTRAINT "documents_roles_check" CHECK (cardinality("documents"."allowed_roles") > 0 AND "documents"."allowed_roles" <@ ARRAY['admin','sales_manager','sales_rep','viewer']::text[] AND array_position("documents"."allowed_roles", NULL) IS NULL)
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_document_id_documents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE POLICY "chunks_tenant_isolation" ON "chunks" AS PERMISSIVE FOR ALL TO "analytics_ro", "app_user" USING ("chunks"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("chunks"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "documents_tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO "analytics_ro", "app_user" USING ("documents"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("documents"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);