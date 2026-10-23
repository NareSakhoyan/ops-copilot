CREATE TABLE "sql_execution_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"question" text,
	"sql" text NOT NULL,
	"verdict" text NOT NULL,
	"rows" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text,
	CONSTRAINT "sql_execution_log_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sql_execution_log_verdict_check" CHECK ("sql_execution_log"."verdict" IN ('accepted', 'rejected', 'error')),
	CONSTRAINT "sql_execution_log_rows_check" CHECK ("sql_execution_log"."rows" BETWEEN 0 AND 200),
	CONSTRAINT "sql_execution_log_duration_check" CHECK ("sql_execution_log"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sql_execution_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sql_execution_log" ADD CONSTRAINT "sql_execution_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sql_execution_log" ADD CONSTRAINT "sql_execution_log_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."v_contacts_activity" WITH (security_barrier = true, security_invoker = true) AS (select "contacts"."id", "contacts"."tenant_id", "contacts"."name", "contacts"."company_id", max("activities"."occurred_at") as "last_activity_at" from "contacts" left join "activities" on ("activities"."tenant_id" = "contacts"."tenant_id" and "activities"."contact_id" = "contacts"."id") where current_setting('app.analytics_scope', true) = 'tenant' OR exists (select "deals"."id" from "deals" left join "employees" on ("employees"."tenant_id" = "deals"."tenant_id" and "employees"."id" = "deals"."responsible_employee_id") where ("deals"."tenant_id" = "contacts"."tenant_id" and "deals"."contact_id" = "contacts"."id" and (
    current_setting('app.analytics_scope', true) = 'tenant'
    OR (current_setting('app.analytics_scope', true) = 'department'
      AND "employees"."department_id" = nullif(current_setting('app.analytics_department_id', true), '')::uuid)
    OR (current_setting('app.analytics_scope', true) = 'employee'
      AND "deals"."responsible_employee_id" = nullif(current_setting('app.analytics_employee_id', true), '')::uuid)
  ))) group by "contacts"."id", "contacts"."tenant_id", "contacts"."name", "contacts"."company_id");--> statement-breakpoint
CREATE VIEW "public"."v_deals" WITH (security_barrier = true, security_invoker = true) AS (select "deals"."id", "deals"."tenant_id", "deals"."title", "deals"."status", "deals"."amount", "deals"."currency", "deals"."created_at", "deals"."closed_at", "deals"."company_id", "deals"."contact_id", "deals"."responsible_employee_id", "employees"."department_id" from "deals" left join "employees" on ("employees"."tenant_id" = "deals"."tenant_id" and "employees"."id" = "deals"."responsible_employee_id") where (
    current_setting('app.analytics_scope', true) = 'tenant'
    OR (current_setting('app.analytics_scope', true) = 'department'
      AND "employees"."department_id" = nullif(current_setting('app.analytics_department_id', true), '')::uuid)
    OR (current_setting('app.analytics_scope', true) = 'employee'
      AND "deals"."responsible_employee_id" = nullif(current_setting('app.analytics_employee_id', true), '')::uuid)
  ));--> statement-breakpoint
CREATE VIEW "public"."v_employee_performance" WITH (security_barrier = true, security_invoker = true) AS (select "employees"."id" as "employee_id", "employees"."tenant_id", "employees"."name" as "employee_name", "employees"."department_id", "deals"."currency", count("deals"."id") as "deal_count", count("deals"."id") FILTER (WHERE "deals"."status" = 'won') as "won_count", count("deals"."id") FILTER (WHERE "deals"."status" = 'lost') as "lost_count", count("deals"."id") FILTER (WHERE "deals"."status" = 'open') as "open_count", coalesce(sum("deals"."amount") FILTER (WHERE "deals"."status" = 'won'), 0) as "won_amount" from "employees" left join "deals" on ("deals"."tenant_id" = "employees"."tenant_id" and "deals"."responsible_employee_id" = "employees"."id") where (
    current_setting('app.analytics_scope', true) = 'tenant'
    OR (current_setting('app.analytics_scope', true) = 'department'
      AND "employees"."department_id" = nullif(current_setting('app.analytics_department_id', true), '')::uuid)
    OR (current_setting('app.analytics_scope', true) = 'employee'
      AND "employees"."id" = nullif(current_setting('app.analytics_employee_id', true), '')::uuid)
  ) group by "employees"."id", "employees"."tenant_id", "employees"."name", "employees"."department_id", "deals"."currency");--> statement-breakpoint
CREATE VIEW "public"."v_tasks" WITH (security_barrier = true, security_invoker = true) AS (select "tasks"."id", "tasks"."tenant_id", "tasks"."title", "tasks"."status", "tasks"."assignee_employee_id", "employees"."department_id", "tasks"."due_at", "tasks"."created_at", "tasks"."contact_id", "tasks"."deal_id" from "tasks" inner join "employees" on ("employees"."tenant_id" = "tasks"."tenant_id" and "employees"."id" = "tasks"."assignee_employee_id") where (
    current_setting('app.analytics_scope', true) = 'tenant'
    OR (current_setting('app.analytics_scope', true) = 'department'
      AND "employees"."department_id" = nullif(current_setting('app.analytics_department_id', true), '')::uuid)
    OR (current_setting('app.analytics_scope', true) = 'employee'
      AND "tasks"."assignee_employee_id" = nullif(current_setting('app.analytics_employee_id', true), '')::uuid)
  ));--> statement-breakpoint
CREATE POLICY "sql_execution_log_tenant_isolation" ON "sql_execution_log" AS PERMISSIVE FOR ALL TO "analytics_ro", "app_user" USING ("sql_execution_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("sql_execution_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);