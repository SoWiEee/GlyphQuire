CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_size_check" CHECK (octet_length("rate_limit_buckets"."bucket_key") between 1 and 255),
	CONSTRAINT "rate_limit_buckets_request_count_nonnegative_check" CHECK ("rate_limit_buckets"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_reservations" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"bucket_key" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rate_limit_reservations" ADD CONSTRAINT "rate_limit_reservations_bucket_fk" FOREIGN KEY ("bucket_key") REFERENCES "public"."rate_limit_buckets"("bucket_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_started_at_idx" ON "rate_limit_buckets" USING btree ("window_started_at");
--> statement-breakpoint
CREATE INDEX "rate_limit_reservations_bucket_window_idx" ON "rate_limit_reservations" USING btree ("bucket_key","window_started_at");
--> statement-breakpoint
CREATE FUNCTION "rate_limit_owner_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_class AS rate_limit_table
		JOIN pg_catalog.pg_roles AS owner_role
			ON owner_role.oid = rate_limit_table.relowner
		WHERE rate_limit_table.oid = TG_RELID
			AND owner_role.rolname = current_user
	) THEN
		RAISE EXCEPTION 'only the exact rate-limit table owner may delete rows'
			USING ERRCODE = '42501';
	END IF;
	RETURN OLD;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER "rate_limit_buckets_owner_delete_guard"
BEFORE DELETE ON "rate_limit_buckets"
FOR EACH ROW
EXECUTE FUNCTION "rate_limit_owner_delete_guard"();
--> statement-breakpoint
CREATE TRIGGER "rate_limit_reservations_owner_delete_guard"
BEFORE DELETE ON "rate_limit_reservations"
FOR EACH ROW
EXECUTE FUNCTION "rate_limit_owner_delete_guard"();
