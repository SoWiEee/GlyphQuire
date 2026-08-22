CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_size_check" CHECK (octet_length("rate_limit_buckets"."bucket_key") between 1 and 255),
	CONSTRAINT "rate_limit_buckets_request_count_positive_check" CHECK ("rate_limit_buckets"."request_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_started_at_idx" ON "rate_limit_buckets" USING btree ("window_started_at");
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'glyphquire_app') THEN
		REVOKE DELETE ON TABLE "rate_limit_buckets" FROM glyphquire_app;
	END IF;
END
$$;
