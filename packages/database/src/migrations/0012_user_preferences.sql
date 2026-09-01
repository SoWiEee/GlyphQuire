CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme_id" uuid,
	"mode" varchar(5) DEFAULT 'light' NOT NULL,
	"custom_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variant_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_mode_check" CHECK ("user_preferences"."mode" in ('light', 'dark')),
	CONSTRAINT "user_preferences_revision_positive_check" CHECK ("user_preferences"."revision" > 0),
	CONSTRAINT "user_preferences_custom_overrides_object_check" CHECK (jsonb_typeof("user_preferences"."custom_overrides") = 'object'),
	CONSTRAINT "user_preferences_variant_overrides_object_check" CHECK (jsonb_typeof("user_preferences"."variant_overrides") = 'object')
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_preferences_theme_id_idx" ON "user_preferences" USING btree ("theme_id");