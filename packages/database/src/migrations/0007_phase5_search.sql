CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"headings" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '' NOT NULL,
	"normalized_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(headings, '') || ' ' || coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_revision_positive_check" CHECK ("search_documents"."revision" > 0),
	CONSTRAINT "search_documents_title_size_check" CHECK (octet_length("search_documents"."title") <= 2097152),
	CONSTRAINT "search_documents_headings_size_check" CHECK (octet_length("search_documents"."headings") <= 2097152),
	CONSTRAINT "search_documents_body_size_check" CHECK (octet_length("search_documents"."body") <= 2097152),
	CONSTRAINT "search_documents_normalized_text_size_check" CHECK (octet_length("search_documents"."normalized_text") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_note_workspace_fk" FOREIGN KEY ("note_id","workspace_id") REFERENCES "public"."notes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_note_id_unique" ON "search_documents" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "search_documents_workspace_updated_id_idx" ON "search_documents" USING btree ("workspace_id","updated_at","note_id");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "search_documents_normalized_trgm_idx" ON "search_documents" USING gin ("normalized_text" gin_trgm_ops);