CREATE TABLE "document_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"note_operation_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"locked_at" timestamp,
	"locked_by" text,
	"completed_at" timestamp,
	"dead_lettered_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_jobs_revision_positive_check" CHECK ("document_jobs"."revision" > 0),
	CONSTRAINT "document_jobs_kind_check" CHECK ("document_jobs"."kind" in ('upsert', 'delete')),
	CONSTRAINT "document_jobs_status_check" CHECK ("document_jobs"."status" in ('pending', 'processing', 'completed', 'dead_letter')),
	CONSTRAINT "document_jobs_attempts_nonnegative_check" CHECK ("document_jobs"."attempts" >= 0),
	CONSTRAINT "document_jobs_state_shape_check" CHECK ((
          "document_jobs"."status" = 'pending'
          and "document_jobs"."locked_at" is null
          and "document_jobs"."locked_by" is null
          and "document_jobs"."completed_at" is null
          and "document_jobs"."dead_lettered_at" is null
        ) or (
          "document_jobs"."status" = 'processing'
          and "document_jobs"."attempts" > 0
          and "document_jobs"."locked_at" is not null
          and "document_jobs"."locked_by" is not null
          and "document_jobs"."completed_at" is null
          and "document_jobs"."dead_lettered_at" is null
        ) or (
          "document_jobs"."status" = 'completed'
          and "document_jobs"."attempts" > 0
          and "document_jobs"."locked_at" is null
          and "document_jobs"."locked_by" is null
          and "document_jobs"."completed_at" is not null
          and "document_jobs"."dead_lettered_at" is null
        ) or (
          "document_jobs"."status" = 'dead_letter'
          and "document_jobs"."attempts" > 0
          and "document_jobs"."locked_at" is null
          and "document_jobs"."locked_by" is null
          and "document_jobs"."completed_at" is null
          and "document_jobs"."dead_lettered_at" is not null
        ))
);
--> statement-breakpoint
CREATE TABLE "note_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"base_revision" integer,
	"request_hash" text NOT NULL,
	"recorded_response" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "note_operations_kind_check" CHECK ("note_operations"."operation_kind" in ('create', 'rename', 'save', 'delete', 'restore', 'checkpoint', 'restore_version')),
	CONSTRAINT "note_operations_base_revision_check" CHECK (("note_operations"."operation_kind" = 'create' and "note_operations"."base_revision" is null)
        or ("note_operations"."operation_kind" <> 'create' and "note_operations"."base_revision" > 0)),
	CONSTRAINT "note_operations_request_hash_check" CHECK (char_length("note_operations"."request_hash") > 0)
);
--> statement-breakpoint
CREATE TABLE "note_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"content_markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "note_versions_revision_positive_check" CHECK ("note_versions"."revision" > 0),
	CONSTRAINT "note_versions_schema_version_positive_check" CHECK ("note_versions"."schema_version" > 0),
	CONSTRAINT "note_versions_reason_check" CHECK ("note_versions"."reason" in ('autosave', 'checkpoint', 'restore', 'migration', 'import')),
	CONSTRAINT "note_versions_markdown_size_check" CHECK (octet_length("note_versions"."content_markdown") <= 2097152)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"owner_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "notes_visibility_private_check" CHECK ("notes"."visibility" = 'private'),
	CONSTRAINT "notes_revision_positive_check" CHECK ("notes"."revision" > 0),
	CONSTRAINT "notes_schema_version_positive_check" CHECK ("notes"."schema_version" > 0),
	CONSTRAINT "notes_title_length_check" CHECK (char_length("notes"."title") between 1 and 200),
	CONSTRAINT "notes_markdown_size_check" CHECK (octet_length("notes"."content_markdown") <= 2097152)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notes_id_workspace_id_unique" ON "notes" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_operations_job_reference_unique" ON "note_operations" USING btree ("id","workspace_id","note_id","operation_id");--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_operation_identity_fk" FOREIGN KEY ("note_operation_id","workspace_id","note_id","operation_id") REFERENCES "public"."note_operations"("id","workspace_id","note_id","operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_operations" ADD CONSTRAINT "note_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_operations" ADD CONSTRAINT "note_operations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_operations" ADD CONSTRAINT "note_operations_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_jobs_identity_unique" ON "document_jobs" USING btree ("note_id","revision","operation_id");--> statement-breakpoint
CREATE INDEX "document_jobs_workspace_note_revision_idx" ON "document_jobs" USING btree ("workspace_id","note_id","revision");--> statement-breakpoint
CREATE INDEX "document_jobs_pending_due_idx" ON "document_jobs" USING btree ("status","available_at","created_at","id") WHERE "document_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "document_jobs_processing_lock_idx" ON "document_jobs" USING btree ("status","locked_at") WHERE "document_jobs"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "note_operations_create_scope_unique" ON "note_operations" USING btree ("actor_id","workspace_id","operation_kind","operation_id") WHERE "note_operations"."operation_kind" = 'create';--> statement-breakpoint
CREATE UNIQUE INDEX "note_operations_existing_scope_unique" ON "note_operations" USING btree ("actor_id","workspace_id","note_id","operation_kind","operation_id") WHERE "note_operations"."operation_kind" <> 'create';--> statement-breakpoint
CREATE UNIQUE INDEX "note_versions_note_revision_unique" ON "note_versions" USING btree ("note_id","revision");--> statement-breakpoint
CREATE INDEX "note_versions_workspace_note_revision_idx" ON "note_versions" USING btree ("workspace_id","note_id","revision");--> statement-breakpoint
CREATE INDEX "notes_workspace_deleted_updated_id_idx" ON "notes" USING btree ("workspace_id","deleted_at","updated_at","id");--> statement-breakpoint
CREATE INDEX "notes_workspace_id_revision_visibility_deleted_idx" ON "notes" USING btree ("workspace_id","id","revision","visibility","deleted_at");--> statement-breakpoint
CREATE FUNCTION "guard_document_job_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'document jobs cannot be deleted'
			USING ERRCODE = '55000';
	END IF;

	IF OLD."status" IN ('completed', 'dead_letter') THEN
		RAISE EXCEPTION 'terminal document jobs are immutable'
			USING ERRCODE = '55000';
	END IF;

	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
		OR NEW."note_id" IS DISTINCT FROM OLD."note_id"
		OR NEW."note_operation_id" IS DISTINCT FROM OLD."note_operation_id"
		OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
		OR NEW."revision" IS DISTINCT FROM OLD."revision"
		OR NEW."kind" IS DISTINCT FROM OLD."kind"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'document job identity is immutable'
			USING ERRCODE = '55000';
	END IF;

	IF NEW."attempts" < OLD."attempts" THEN
		RAISE EXCEPTION 'document job attempts cannot decrease'
			USING ERRCODE = '23514';
	END IF;

	IF NOT (
		(OLD."status" = 'pending' AND NEW."status" IN ('pending', 'processing'))
		OR (
			OLD."status" = 'processing'
			AND NEW."status" IN ('processing', 'pending', 'completed', 'dead_letter')
		)
	) THEN
		RAISE EXCEPTION 'invalid document job status transition'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "document_jobs_update_guard"
BEFORE UPDATE OR DELETE ON "document_jobs"
FOR EACH ROW
EXECUTE FUNCTION "guard_document_job_update"();--> statement-breakpoint
CREATE FUNCTION "guard_note_revision_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
		OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'note identity and tenant ownership are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."revision" <> OLD."revision" + 1 THEN
		RAISE EXCEPTION 'note revision must increase exactly by one'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "notes_revision_guard"
BEFORE UPDATE ON "notes"
FOR EACH ROW
EXECUTE FUNCTION "guard_note_revision_update"();--> statement-breakpoint
CREATE FUNCTION "reject_immutable_note_record_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
		USING ERRCODE = '55000';
	RETURN OLD;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "note_versions_immutable"
BEFORE UPDATE OR DELETE ON "note_versions"
FOR EACH ROW
EXECUTE FUNCTION "reject_immutable_note_record_mutation"();--> statement-breakpoint
CREATE TRIGGER "note_operations_immutable"
BEFORE UPDATE OR DELETE ON "note_operations"
FOR EACH ROW
EXECUTE FUNCTION "reject_immutable_note_record_mutation"();
