# Icons, Theme Persistence, and Custom Blocks Design

**Status:** Approved design

**Goal:** Add a coherent icon language, persist authenticated user theme preferences across workspaces and devices, and deliver workspace-scoped declarative Custom Blocks without executable application code.

## Product decisions

- Icons use the current `@lucide/vue` package with a single web `GqIcon` wrapper. Icon names are allowlisted in `packages/theme-sdk`; the wrapper controls size, stroke width, `currentColor`, and decorative versus labelled semantics.
- Theme preferences are user-scoped. The server stores the selected system theme, `light`/`dark` mode, token overrides, component variant overrides, and a revision. No localStorage fallback is used. Workspace-selected themes remain workspace-scoped; global user preferences control the user's display mode and global overrides.
- Custom Blocks are declarative only. Users may define a name, version, directive kind, constrained props schema, nested-content policy, allowlisted icon, approved component preset/variant, token mapping, and declared capability. Custom definitions cannot contain Vue, JavaScript, HTML, arbitrary CSS, filesystem access, credentials, or unrestricted network access.
- The first Custom Block release accepts only `static` and `interactive-ui` capabilities. Existing `p5` and `canvas` blocks continue to use the established sandbox runtime; custom runtime requests are rejected until a separately approved runtime contract exists.

## Architecture

`packages/theme-sdk` owns shared Zod schemas, icon names, and API types. `packages/document-engine` adds a `custom-block` AST node and a declarative interpreter that maps definitions to approved primitives. Parsing and serialization retain a directive's name, version, attributes, children, and source when a definition is unavailable, so unsupported content remains recoverable without a compatibility layer.

The API adds `user_preferences`, `custom_blocks`, and `custom_block_versions` through a new migration. Custom block drafts are mutable; published versions are immutable. Workspace owners and editors may mutate definitions, while viewers may list and resolve them. Every mutation requires membership, permission, `operationId`, and `baseRevision` CAS. User preference writes require the authenticated actor and never accept a workspace or another user id.

Routes are:

- `GET/PUT /api/v1/me/preferences/theme`
- `GET/POST /api/v1/workspaces/:workspaceId/custom-blocks`
- `PUT /api/v1/custom-blocks/:id/draft`
- `POST /api/v1/custom-blocks/:id/publish`
- `DELETE /api/v1/custom-blocks/:id` for unpublished drafts only

The web app loads preferences at authenticated app bootstrap, applies them through `ThemeProvider`, and only commits a Theme Editor draft after the server succeeds. The Workbench exposes Custom Blocks management, preview, publish, and a block picker. Missing definitions render an unsupported placeholder and preserve the authored directive.

## Security and validation

Names cannot collide with built-ins, schemas use a bounded JSON-compatible subset, and icon/preset/variant/capability values are allowlists. Server validation is authoritative; client validation is for usability only. No custom definition is evaluated as code, CSS, or markup in the main origin.

## Verification

Cover schema and allowlist units, parser/serializer round-trips, migration constraints, API authorization/CAS/error envelopes, theme load/save failure behavior, and one desktop Chrome keyboard smoke for icon labels, theme switching, and Custom Block insertion. Do not add broad visual snapshots or mobile E2E coverage.
