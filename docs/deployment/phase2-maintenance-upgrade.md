# Phase 0 to Phase 2 maintenance upgrade

This is a maintenance-window upgrade. Running the Phase 0 and Phase 2 API at
the same time is unsupported. Stop every old API and worker process and disable
registration before the backup begins; keep them stopped until the new API has
passed its smoke test.

This constraint is not a zero-downtime limitation added by the migration. The
installed Better Auth 1.7.1 writes `account.issuer`, while the Phase 0 database
does not have that column. A signup against the pre-migration catalog returns
500 and can leave a user without a credential account. Do not accept signup or
other auth writes during this procedure.

## Local Docker Compose upgrade

The commands in this section are only for the repository's local Compose
database, `glyphquire_dev`. The committed passwords are development values and
must never be reused in production.

1. Check out the Phase 2 release, but do not start its API. Stop any existing
   `pnpm dev`, API, and worker processes. Confirm that registration is
   unreachable.
2. Restrict the backup file before writing it, then back up the running Phase 0
   database through the legacy role:

   ```bash
   umask 077
   docker compose exec -T postgres pg_dump \
     --username=glyphquire \
     --dbname=glyphquire_dev \
     --format=custom > glyphquire-phase0.dump
   docker compose exec -T postgres pg_restore --list \
     < glyphquire-phase0.dump >/dev/null
   sha256sum glyphquire-phase0.dump
   ```

   Store the dump and its hash outside the deployment host. It contains user
   data and password hashes.

3. Bootstrap the new roles through the still-present legacy `glyphquire`
   owner:

   ```bash
   pnpm db:upgrade:phase0-compose
   pnpm db:preflight:roles-compose
   ```

   These commands are versioned and idempotent. The bootstrap is transactional
   and removes stale role memberships; the preflight fails if either application
   login has elevated attributes or can assume any other role. They do not rely
   on `/docker-entrypoint-initdb.d`, which PostgreSQL skips for an existing
   volume. It transfers the database, `public` schema, tables, and sequences to
   `glyphquire_migration`, then grants `glyphquire_app` only connection, schema
   usage, table DML, and sequence usage.

4. Load the two local development URLs without printing them:

   ```bash
   export MIGRATION_DATABASE_URL='postgresql://glyphquire_migration:glyphquire_migration_dev@localhost:5432/glyphquire_dev'
   export DATABASE_URL='postgresql://glyphquire_app:glyphquire_app_dev@localhost:5432/glyphquire_dev'
   ```

5. Verify the exact frozen Phase 0 catalog and record its `0000` journal entry,
   then migrate:

   ```bash
   pnpm db:verify-baseline
   pnpm db:preflight:roles-compose
   pnpm db:migrate
   ```

   Stop on either failure. The verifier rejects modified or partial Phase 0
   catalogs. Migration `0001` rejects unknown OAuth issuers and duplicate
   credential identities; its schema, data backfill, and journal write are one
   transaction, so a rejection leaves no Phase 2 artifacts or partial issuer
   data.

6. Start only the Phase 2 API and worker using `DATABASE_URL`. Smoke-test a new
   credential signup, sign-in, the Personal workspace response, and one normal
   runtime write. Inspect logs for migration or authorization errors.
7. After acceptance, retain the backup according to the deployment's recovery
   policy. Never restart a Phase 0 API against the migrated database.

The role-bootstrap command may be rerun after `0001`; it reapplies runtime
grants to migration-owned tables and sequences without expanding the
application role. The local legacy role remains available so the command and
restore procedure stay repeatable.

## Failure and restore

Keep both old and new APIs stopped after any failed preflight, migration, or
smoke test. Preserve the failed database for diagnosis before restoring.

For the local Compose database, restore the verified dump into a clean Phase 0
database through the legacy superuser:

```bash
docker compose exec -T postgres psql \
  --username=glyphquire --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'glyphquire_dev' AND pid <> pg_backend_pid()"
docker compose exec -T postgres dropdb \
  --username=glyphquire --if-exists glyphquire_dev
docker compose exec -T postgres createdb \
  --username=glyphquire --owner=glyphquire glyphquire_dev
docker compose exec -T postgres pg_restore \
  --username=glyphquire --dbname=glyphquire_dev \
  --exit-on-error --single-transaction < glyphquire-phase0.dump
```

Verify the restored application with the Phase 0 release before re-enabling
traffic or registration. Cluster-global Phase 2 roles may remain dormant after
restore; the next upgrade reruns the bootstrap safely.

## Production contract

Do not run `infra/postgres/upgrade/001_phase0_roles.sql` in production. It has
fixed local identifiers and public development passwords. A production DBA
must perform the equivalent operation with credentials generated and delivered
by the deployment's secret manager, without putting URLs or passwords in shell
arguments, CI output, or logs:

- the migration login is
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
  and owns only the target database, application schema, tables, and sequences;
- the runtime login is
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  owns no objects, cannot create in the database or schema, and receives only
  table `SELECT`, `INSERT`, `UPDATE`, `DELETE` plus sequence `USAGE`;
- neither login is a member of another role; production preflight must reject
  every direct membership because `NOINHERIT` alone still permits `SET ROLE`;
- the runtime login receives no access to the `drizzle` schema or migration
  journal and no sequence `UPDATE`, so it cannot run `setval`;
- production role bootstrap and ownership transfer run inside a maintenance
  change with a tested backup and restore command appropriate to that provider;
- `MIGRATION_DATABASE_URL` is available only to the migration job, while API
  and worker processes receive only `DATABASE_URL`;
- retire or disable the legacy login only after the new release and restore
  procedure have been accepted.

The same sequence applies in production: stop writes, back up, bootstrap roles,
verify the exact baseline, migrate, deploy only the new API, smoke-test, then
restore from backup on failure. Old/new overlap and registration during the
window are explicitly unsupported.
