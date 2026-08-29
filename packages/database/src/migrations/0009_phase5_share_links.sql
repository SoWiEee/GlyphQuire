CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"creator_id" text NOT NULL,
	"scope_type" varchar(16) DEFAULT 'note' NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_scope_check" CHECK ("share_links"."scope_type" = 'note'),
	CONSTRAINT "share_links_token_hash_check" CHECK ("share_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "share_links_expiry_check" CHECK ("share_links"."expires_at" is null or "share_links"."expires_at" > "share_links"."created_at"),
	CONSTRAINT "share_links_revocation_check" CHECK ("share_links"."revoked_at" is null or "share_links"."revoked_at" >= "share_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_creator_membership_fk" FOREIGN KEY ("workspace_id","creator_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_unique" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_expiry_cleanup_idx" ON "share_links" USING btree ("workspace_id","expires_at","created_at","id");--> statement-breakpoint
CREATE INDEX "share_links_revocation_cleanup_idx" ON "share_links" USING btree ("workspace_id","revoked_at","created_at","id");