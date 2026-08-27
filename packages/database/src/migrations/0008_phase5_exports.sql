CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_id" text NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"note_id" uuid,
	"format" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"object_key" varchar(500),
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" varchar(4000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exports_scope_type_check" CHECK ("exports"."scope_type" in ('workspace', 'note')),
	CONSTRAINT "exports_format_check" CHECK ("exports"."format" in ('markdown', 'zip', 'html')),
	CONSTRAINT "exports_status_check" CHECK ("exports"."status" in ('pending', 'processing', 'completed', 'failed', 'expired')),
	CONSTRAINT "exports_scope_shape_check" CHECK (("exports"."scope_type" = 'workspace' and "exports"."note_id" is null)
        or ("exports"."scope_type" = 'note' and "exports"."note_id" is not null)),
	CONSTRAINT "exports_object_key_check" CHECK ("exports"."object_key" is null
        or "exports"."object_key" = 'workspace/' || "exports"."workspace_id"::text || '/exports/' || "exports"."id"::text || '/artifact'),
	CONSTRAINT "exports_request_hash_check" CHECK ("exports"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exports_idempotency_key_check" CHECK (char_length("exports"."idempotency_key") > 0),
	CONSTRAINT "exports_expiry_check" CHECK ("exports"."expires_at" > "exports"."created_at")
);
--> statement-breakpoint
CREATE TABLE "import_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid,
	"object_key" varchar(500) NOT NULL,
	"state" varchar(16) DEFAULT 'declared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_resources_state_check" CHECK ("import_resources"."state" in ('declared', 'uploaded', 'promoted', 'cleaned')),
	CONSTRAINT "import_resources_object_key_check" CHECK ("import_resources"."object_key" = 'workspace/' || "import_resources"."workspace_id"::text || '/imports/' || "import_resources"."import_id"::text || '/resources/' || "import_resources"."id"::text),
	CONSTRAINT "import_resources_promoted_asset_check" CHECK ("import_resources"."state" <> 'promoted' or "import_resources"."asset_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"target_note_id" uuid,
	"base_revision" integer,
	"source_object_key" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'staging' NOT NULL,
	"compensation_status" varchar(16) DEFAULT 'none' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" varchar(4000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_status_check" CHECK ("imports"."status" in ('staging', 'pending', 'processing', 'completed', 'failed', 'expired')),
	CONSTRAINT "imports_compensation_status_check" CHECK ("imports"."compensation_status" in ('none', 'required', 'running', 'completed', 'failed')),
	CONSTRAINT "imports_target_revision_shape_check" CHECK (("imports"."target_note_id" is null and "imports"."base_revision" is null)
        or ("imports"."target_note_id" is not null and "imports"."base_revision" is not null and "imports"."base_revision" > 0)),
	CONSTRAINT "imports_source_object_key_check" CHECK ("imports"."source_object_key" = 'workspace/' || "imports"."workspace_id"::text || '/imports/' || "imports"."id"::text || '/source'),
	CONSTRAINT "imports_request_hash_check" CHECK ("imports"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "imports_idempotency_key_check" CHECK (char_length("imports"."idempotency_key") > 0),
	CONSTRAINT "imports_manifest_check" CHECK (jsonb_typeof("imports"."manifest") = 'object' and octet_length("imports"."manifest"::text) <= 1048576),
	CONSTRAINT "imports_expiry_check" CHECK ("imports"."expires_at" > "imports"."created_at")
);
--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imports_id_workspace_id_unique" ON "imports" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "import_resources" ADD CONSTRAINT "import_resources_import_workspace_fk" FOREIGN KEY ("import_id","workspace_id") REFERENCES "public"."imports"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_target_note_workspace_fk" FOREIGN KEY ("target_note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exports_idempotency_scope_unique" ON "exports" USING btree ("workspace_id","requester_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "exports_expiry_status_idx" ON "exports" USING btree ("status","expires_at","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_resources_object_key_unique" ON "import_resources" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "import_resources_import_state_idx" ON "import_resources" USING btree ("import_id","workspace_id","state","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "imports_idempotency_scope_unique" ON "imports" USING btree ("workspace_id","actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "imports_staging_cleanup_idx" ON "imports" USING btree ("status","compensation_status","expires_at","created_at","id");
