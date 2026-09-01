ALTER TABLE "custom_block_versions" ADD COLUMN "operation_kind" varchar(12) DEFAULT 'create' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_block_versions" ALTER COLUMN "operation_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "custom_block_versions" ADD CONSTRAINT "custom_block_versions_operation_kind_check" CHECK ("custom_block_versions"."operation_kind" in ('create', 'update-draft', 'publish'));
