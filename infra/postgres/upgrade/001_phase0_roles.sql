-- Local Docker Compose upgrade only. The passwords below are committed development
-- credentials, not production secrets. Production operators must create equivalent
-- roles with credentials from their secret manager; see the Phase 2 upgrade runbook.
--
-- Run this file as the legacy `glyphquire` cluster bootstrap role. PostgreSQL does
-- not rerun /docker-entrypoint-initdb.d for an existing data volume, so this script
-- deliberately transfers the exact Phase 0 database before application migrations.

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'glyphquire_migration') THEN
    CREATE ROLE glyphquire_migration LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'glyphquire_app') THEN
    CREATE ROLE glyphquire_app LOGIN;
  END IF;
END
$roles$;

ALTER ROLE glyphquire_migration
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD 'glyphquire_migration_dev';
ALTER ROLE glyphquire_app
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD 'glyphquire_app_dev';

-- NOINHERIT does not disable SET ROLE. Remove every stale membership edge so
-- neither application-owned login can assume another role, directly or through
-- a membership chain.
DO $memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT
      granted.rolname AS granted_role,
      member.rolname AS member_role,
      grantor.rolname AS grantor_role
    FROM pg_catalog.pg_auth_members auth_members
    JOIN pg_catalog.pg_roles granted ON granted.oid = auth_members.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = auth_members.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = auth_members.grantor
    WHERE member.rolname IN ('glyphquire_app', 'glyphquire_migration')
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY %I',
      membership.granted_role,
      membership.member_role,
      membership.grantor_role
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members auth_members
    JOIN pg_catalog.pg_roles member ON member.oid = auth_members.member
    WHERE member.rolname IN ('glyphquire_app', 'glyphquire_migration')
  ) THEN
    RAISE EXCEPTION
      'Phase 0 role upgrade refused: application login retains a role membership';
  END IF;
END
$memberships$;

ALTER DATABASE glyphquire_dev OWNER TO glyphquire_migration;
ALTER SCHEMA public OWNER TO glyphquire_migration;

DO $ownership$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT table_class.relname, table_class.relkind
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = table_class.relowner
    WHERE namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p', 'S')
      AND owner_role.rolname = 'glyphquire'
  LOOP
    IF relation.relkind = 'S' THEN
      EXECUTE format(
        'ALTER SEQUENCE public.%I OWNER TO glyphquire_migration',
        relation.relname
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I OWNER TO glyphquire_migration',
        relation.relname
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = table_class.relowner
    WHERE namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p', 'S')
      AND owner_role.rolname <> 'glyphquire_migration'
  ) THEN
    RAISE EXCEPTION
      'Phase 0 role upgrade refused: a public table or sequence has an unexpected owner';
  END IF;
END
$ownership$;

REVOKE ALL ON DATABASE glyphquire_dev FROM PUBLIC;
REVOKE ALL ON DATABASE glyphquire_dev FROM glyphquire_app;
GRANT CONNECT ON DATABASE glyphquire_dev TO glyphquire_app;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM glyphquire_app;
GRANT USAGE ON SCHEMA public TO glyphquire_app;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM glyphquire_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO glyphquire_app;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM glyphquire_app;
GRANT USAGE
  ON ALL SEQUENCES IN SCHEMA public
  TO glyphquire_app;

ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  REVOKE ALL ON TABLES FROM glyphquire_app;
ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO glyphquire_app;

ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM glyphquire_app;
ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO glyphquire_app;

COMMIT;
