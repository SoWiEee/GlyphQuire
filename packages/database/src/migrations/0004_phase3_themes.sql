CREATE TABLE "themes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL,
  "version" varchar(50) NOT NULL,
  "tokens" jsonb DEFAULT '{}' NOT NULL,
  "dark_tokens" jsonb,
  "components" jsonb,
  "is_system" boolean DEFAULT false NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "themes_revision_positive_check" CHECK ("themes"."revision" > 0),
  CONSTRAINT "themes_system_workspace_null_check" CHECK (
    ("themes"."is_system" = true AND "themes"."workspace_id" IS NULL) OR
    ("themes"."is_system" = false AND "themes"."workspace_id" IS NOT NULL)
  ),
  CONSTRAINT "themes_name_length_check" CHECK (char_length("themes"."name") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "themes_workspace_name_unique"
  ON "themes" ("workspace_id", "name")
  WHERE "workspace_id" IS NOT NULL;

CREATE INDEX "themes_workspace_id_idx" ON "themes" ("workspace_id");

CREATE TABLE "user_themes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "theme_id" uuid NOT NULL REFERENCES "themes"("id") ON DELETE CASCADE,
  "custom_overrides" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "user_themes_user_workspace_unique"
  ON "user_themes" ("user_id", "workspace_id");

-- Seed system themes
INSERT INTO "themes" ("id", "name", "version", "tokens", "dark_tokens", "is_system") VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'Default Light',
    '1.0.0',
    '{"color":{"background":"#ffffff","foreground":"#1a1a1a","muted":"#6b7280","accent":"#2563eb","border":"#e5e7eb"},"typography":{"bodyFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","headingFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.5rem","lg":"0.75rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'Default Dark',
    '1.0.0',
    '{"color":{"background":"#0f172a","foreground":"#f1f5f9","muted":"#94a3b8","accent":"#60a5fa","border":"#334155"},"typography":{"bodyFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","headingFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.5rem","lg":"0.75rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'Warm Sepia',
    '1.0.0',
    '{"color":{"background":"#fdf6e3","foreground":"#3b2e1a","muted":"#8b7355","accent":"#b58900","border":"#e0d5b7"},"typography":{"bodyFont":"''Georgia'', ''Noto Serif TC'', serif","headingFont":"''Georgia'', ''Noto Serif TC'', serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.375rem","lg":"0.5rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  );
