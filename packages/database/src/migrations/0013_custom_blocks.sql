CREATE TABLE "custom_block_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"custom_block_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(9) NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"operation_id" text NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_block_versions_version_positive_check" CHECK ("custom_block_versions"."version" > 0),
	CONSTRAINT "custom_block_versions_status_check" CHECK ("custom_block_versions"."status" in ('draft', 'published')),
	CONSTRAINT "custom_block_versions_published_at_check" CHECK (("custom_block_versions"."status" = 'published' and "custom_block_versions"."published_at" is not null) or ("custom_block_versions"."status" = 'draft' and "custom_block_versions"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "custom_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_blocks_name_check" CHECK ("custom_blocks"."name" ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "custom_blocks_revision_positive_check" CHECK ("custom_blocks"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "custom_block_versions" ADD CONSTRAINT "custom_block_versions_custom_block_id_custom_blocks_id_fk" FOREIGN KEY ("custom_block_id") REFERENCES "public"."custom_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_block_versions" ADD CONSTRAINT "custom_block_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_blocks" ADD CONSTRAINT "custom_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_blocks" ADD CONSTRAINT "custom_blocks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_block_versions_block_version_unique" ON "custom_block_versions" USING btree ("custom_block_id","version");--> statement-breakpoint
CREATE INDEX "custom_block_versions_block_status_idx" ON "custom_block_versions" USING btree ("custom_block_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_blocks_workspace_name_unique" ON "custom_blocks" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "custom_blocks_workspace_idx" ON "custom_blocks" USING btree ("workspace_id");