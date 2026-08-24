-- The container bootstrap user is the migration role and owns the database.
-- Runtime code connects only as this separate, non-owning application role.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'glyphquire_app') THEN
    CREATE ROLE glyphquire_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      PASSWORD 'glyphquire_app_dev';
  END IF;
END
$roles$;

REVOKE ALL ON DATABASE glyphquire_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE glyphquire_dev TO glyphquire_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM glyphquire_app;
GRANT USAGE ON SCHEMA public TO glyphquire_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO glyphquire_app;
GRANT USAGE
  ON ALL SEQUENCES IN SCHEMA public
  TO glyphquire_app;

ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO glyphquire_app;
ALTER DEFAULT PRIVILEGES FOR ROLE glyphquire_migration IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO glyphquire_app;
