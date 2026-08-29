CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"execute_after" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sanitized_error" varchar(4000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletions_status_check" CHECK ("account_deletions"."status" in ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "account_deletions_workspace_ids_check" CHECK (jsonb_typeof("account_deletions"."workspace_ids") = 'array' and octet_length("account_deletions"."workspace_ids"::text) <= 65536),
	CONSTRAINT "account_deletions_manifest_check" CHECK (jsonb_typeof("account_deletions"."manifest") = 'object' and octet_length("account_deletions"."manifest"::text) <= 1048576),
	CONSTRAINT "account_deletions_idempotency_key_check" CHECK (char_length("account_deletions"."idempotency_key") > 0),
	CONSTRAINT "account_deletions_execute_after_check" CHECK ("account_deletions"."execute_after" >= "account_deletions"."confirmed_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"requested_by" text,
	"confirmed_at" timestamp with time zone NOT NULL,
	"execute_after" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sanitized_error" varchar(4000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_deletions_status_check" CHECK ("workspace_deletions"."status" in ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "workspace_deletions_manifest_check" CHECK (jsonb_typeof("workspace_deletions"."manifest") = 'object' and octet_length("workspace_deletions"."manifest"::text) <= 1048576),
	CONSTRAINT "workspace_deletions_idempotency_key_check" CHECK (char_length("workspace_deletions"."idempotency_key") > 0),
	CONSTRAINT "workspace_deletions_execute_after_check" CHECK ("workspace_deletions"."execute_after" >= "workspace_deletions"."confirmed_at")
);
--> statement-breakpoint
ALTER TABLE "workspace_deletions" ADD CONSTRAINT "workspace_deletions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_deletions" ADD CONSTRAINT "workspace_deletions_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_idempotency_unique" ON "account_deletions" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_active_account_unique" ON "account_deletions" USING btree ("account_id") WHERE "account_deletions"."status" in ('pending', 'processing', 'failed');--> statement-breakpoint
CREATE INDEX "account_deletions_due_idx" ON "account_deletions" USING btree ("status","execute_after","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_deletions_idempotency_unique" ON "workspace_deletions" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_deletions_active_workspace_unique" ON "workspace_deletions" USING btree ("workspace_id") WHERE "workspace_deletions"."workspace_id" is not null and "workspace_deletions"."status" in ('pending', 'processing', 'failed');--> statement-breakpoint
CREATE INDEX "workspace_deletions_due_idx" ON "workspace_deletions" USING btree ("status","execute_after","created_at","id");