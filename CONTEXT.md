# GlyphQuire Domain Context

GlyphQuire is a multi-tenant notebook whose canonical content is Markdown and
whose derived views, search index, transfers, and maintenance jobs must remain
scoped to the owning workspace.

## Notebook and editing

**Workbench**:
A user's active notebook workspace, including its selected note, editor mode,
navigation panels, and persistence state.
_Avoid_: dashboard, page shell

**Editor session**:
The authoritative in-browser editing state for one note and one authenticated
workspace membership.
_Avoid_: draft, editor instance

**Note**:
A Markdown document owned by exactly one workspace and identified by a stable
note identity.
_Avoid_: page, document (when referring to a persisted note)

## Derived services

**Search read**:
A workspace-scoped projection query over indexed note content, ranked and
hydrated into the public search result shape.
_Avoid_: search service (when referring to the query model)

**Transfer**:
A durable import or export operation that progresses from an authenticated
request to a persisted result or a scrubbed failure.
_Avoid_: upload, download (when referring to the whole lifecycle)

**Maintenance job**:
A durable, retryable background operation that owns one bounded cleanup,
rebuild, retention, or verification action.
_Avoid_: task, cron (when referring to the domain operation)

## Persistence and release

**Migration runner**:
The sole release-time process that verifies the repository catalog and applies
ordered database migrations to a target database.
_Avoid_: upgrade script, migration helper
