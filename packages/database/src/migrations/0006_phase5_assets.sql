CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"object_key" varchar(500) NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"mime_type" varchar(200) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"thumbnail_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"thumbnail_object_key" varchar(500),
	"thumbnail_mime_type" varchar(200),
	"thumbnail_width" integer,
	"thumbnail_height" integer,
	"thumbnail_bytes" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "assets_size_bytes_positive_check" CHECK ("assets"."size_bytes" > 0),
	CONSTRAINT "assets_sha256_check" CHECK ("assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assets_thumbnail_status_check" CHECK ("assets"."thumbnail_status" in ('pending', 'ready', 'metadata_only', 'failed')),
	CONSTRAINT "assets_thumbnail_shape_check" CHECK ((
          "assets"."thumbnail_status" in ('pending', 'metadata_only', 'failed')
          and "assets"."thumbnail_object_key" is null
          and "assets"."thumbnail_mime_type" is null
          and "assets"."thumbnail_width" is null
          and "assets"."thumbnail_height" is null
          and "assets"."thumbnail_bytes" is null
        ) or (
          "assets"."thumbnail_status" = 'ready'
          and "assets"."thumbnail_object_key" is not null
          and "assets"."thumbnail_mime_type" is not null
          and "assets"."thumbnail_width" is not null
          and "assets"."thumbnail_height" is not null
          and "assets"."thumbnail_bytes" is not null
        ))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_workspace_object_key_unique" ON "assets" USING btree ("workspace_id","object_key");