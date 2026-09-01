CREATE TABLE "custom_block_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"custom_block_id" uuid,
	"target_block_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"operation_kind" varchar(12) NOT NULL,
	"base_revision" integer,
	"request_hash" text NOT NULL,
	"recorded_response" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_block_operations_kind_check" CHECK ("custom_block_operations"."operation_kind" in ('create', 'update-draft', 'publish', 'delete-draft')),
	CONSTRAINT "custom_block_operations_base_revision_check" CHECK (("custom_block_operations"."operation_kind" = 'create' and "custom_block_operations"."base_revision" is null) or ("custom_block_operations"."operation_kind" <> 'create' and "custom_block_operations"."base_revision" > 0)),
	CONSTRAINT "custom_block_operations_request_hash_check" CHECK (char_length("custom_block_operations"."request_hash") = 64),
	CONSTRAINT "custom_block_operations_response_object_check" CHECK (jsonb_typeof("custom_block_operations"."recorded_response") = 'object')
);
--> statement-breakpoint
ALTER TABLE "custom_block_operations" ADD CONSTRAINT "custom_block_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_block_operations" ADD CONSTRAINT "custom_block_operations_custom_block_id_custom_blocks_id_fk" FOREIGN KEY ("custom_block_id") REFERENCES "public"."custom_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_block_operations" ADD CONSTRAINT "custom_block_operations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_block_operations_actor_scope_unique" ON "custom_block_operations" USING btree ("actor_id","workspace_id","operation_id");--> statement-breakpoint
CREATE INDEX "custom_block_operations_block_idx" ON "custom_block_operations" USING btree ("custom_block_id");--> statement-breakpoint
CREATE INDEX "custom_block_operations_target_idx" ON "custom_block_operations" USING btree ("target_block_id");
