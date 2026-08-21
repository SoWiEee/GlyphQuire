-- Run as glyphquire_migration after role bootstrap and before application
-- migration/deployment. This file contains no credentials and is suitable for
-- adapting to a production provider's preflight job.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('glyphquire_app', 'glyphquire_migration')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role preflight refused: application login has elevated attributes';
  END IF;

  -- Zero direct memberships also removes every possible transitive SET ROLE
  -- path from these login roles.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members auth_members
    JOIN pg_catalog.pg_roles member ON member.oid = auth_members.member
    WHERE member.rolname IN ('glyphquire_app', 'glyphquire_migration')
  ) THEN
    RAISE EXCEPTION 'role preflight refused: application login can assume another role';
  END IF;
END
$preflight$;
