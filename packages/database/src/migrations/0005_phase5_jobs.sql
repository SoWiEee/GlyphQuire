CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation" varchar(80) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response_ciphertext" text,
	"owner_token_hash" char(64),
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_request_hash_check" CHECK ("idempotency_records"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_records_owner_hash_check" CHECK ("idempotency_records"."owner_token_hash" is null or "idempotency_records"."owner_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_records_state_shape_check" CHECK ((
          "idempotency_records"."response_ciphertext" is null
          and "idempotency_records"."completed_at" is null
          and "idempotency_records"."owner_token_hash" is not null
          and "idempotency_records"."lease_expires_at" is not null
        ) or (
          "idempotency_records"."response_ciphertext" is not null
          and "idempotency_records"."completed_at" is not null
          and "idempotency_records"."owner_token_hash" is null
          and "idempotency_records"."lease_expires_at" is null
        ))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"type" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(200),
	"completed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"idempotency_key" varchar(200),
	"last_error" varchar(4000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_version_positive_check" CHECK ("jobs"."version" > 0),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'processing', 'completed', 'dead_letter')),
	CONSTRAINT "jobs_attempts_nonnegative_check" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" between 1 and 20),
	CONSTRAINT "jobs_payload_object_check" CHECK (jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_scope_check" CHECK ("jobs"."workspace_id" is not null or "jobs"."type" in ('workspace.purge', 'account.purge', 'backup.verify')),
	CONSTRAINT "jobs_state_shape_check" CHECK ((
          "jobs"."status" = 'pending'
          and "jobs"."locked_at" is null
          and "jobs"."locked_by" is null
          and "jobs"."completed_at" is null
          and "jobs"."dead_lettered_at" is null
        ) or (
          "jobs"."status" = 'processing'
          and "jobs"."attempts" > 0
          and "jobs"."locked_at" is not null
          and "jobs"."locked_by" is not null
          and "jobs"."completed_at" is null
          and "jobs"."dead_lettered_at" is null
        ) or (
          "jobs"."status" = 'completed'
          and "jobs"."attempts" > 0
          and "jobs"."locked_at" is null
          and "jobs"."locked_by" is null
          and "jobs"."completed_at" is not null
          and "jobs"."dead_lettered_at" is null
        ) or (
          "jobs"."status" = 'dead_letter'
          and "jobs"."attempts" > 0
          and "jobs"."locked_at" is null
          and "jobs"."locked_by" is null
          and "jobs"."completed_at" is null
          and "jobs"."dead_lettered_at" is not null
        ))
);
--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_unique" ON "idempotency_records" USING btree ("workspace_id","actor_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_scope_idx" ON "jobs" USING btree (coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),"type","idempotency_key") WHERE "jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "jobs_pending_due_idx" ON "jobs" USING btree ("status","available_at","created_at","id") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_processing_lock_idx" ON "jobs" USING btree ("status","locked_at") WHERE "jobs"."status" = 'processing';