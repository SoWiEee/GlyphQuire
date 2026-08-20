# Phase 1 Review Remediation Design

> Status: Approved for direct execution
> Date: 2026-08-20
> Scope: Merge blockers found in the final review of `feat/phase1-document-engine`

## Goal

Close the Phase 1 source-preservation, version-rejection, directive-fidelity,
and registry-reservation gaps without expanding v0.1 into custom-block or
editor work.

## Decisions

### Parse failure boundary

`ParseResult` becomes a discriminated union. Accepted input returns
`{ ok: true, document, source, diagnostics, specVersion }`; input that cannot
be interpreted safely returns `{ ok: false, document: null, source,
diagnostics, specVersion }`. The original Markdown is always retained in
`source`.

Unsupported future versions and parser failures are rejected (`ok: false`) and
never transformed into a v1 AST. A malformed directive that remark leaves as
plain text is also rejected for the bounded v0.1 case of a top-level block
directive attribute opener (`::name{` or `:::name{`) whose closing `}` is
missing on that line. Ordinary colon-prefixed prose, escaped syntax, closing
fences, nested quote/list text, and fenced or inline code are not classified as
malformed directives. Recoverable schema-invalid blocks remain accepted
because their source structure is represented by `InvalidBlockNode`.

`importLegacy` applies the same result contract. It accepts only a positive,
supported caller-supplied version and retains the exact original source.
Ordinary `parse` rejects a missing marker, malformed YAML, and non-positive or
non-integer markers; versionless input is accepted only through `importLegacy`.

### Directive fidelity and invalid structure

Unknown and invalid directives retain their original directive kind
(`container`, `leaf`, or `text`) during serialization. Known block definitions
must be invoked only for their declared kind.

When `tabs` or `columns` contains a foreign child, the complete parent becomes
an `InvalidBlockNode`; all attributes and children remain serializable. The
engine reports one `INVALID_CHILD` without deleting the foreign content or
misreporting retained `tab`/`column` children as standalone invalid parents.

A known directive used with the wrong directive kind produces the error code
`DIRECTIVE_KIND_MISMATCH`, becomes an `InvalidBlockNode`, and retains its
original kind. Inline unknown text directives remain MDAST phrasing content and
round-trip through their containing paragraph.

### Registry reservation

Public `BlockRegistry.register()` rejects every reserved built-in name. The
default registry uses a package-internal registration capability to install
the canonical built-in definitions. The capability is not exported from the
package public surface.

### Unknown built-in attributes

Unknown-attribute detection is not a v0.1 requirement. Built-in schemas use an
explicit strip policy: unknown attributes are omitted from the semantic AST
and canonical output without an `ATTRIBUTE_UNKNOWN` diagnostic. The diagnostic
code remains available for future schemas that choose a reporting policy.

## Verification

Every fix follows red-green-refactor. Regression tests must cover future
version rejection, exact source retention, malformed directive rejection,
legacy source retention, unknown leaf preservation, kind mismatch recovery,
invalid-child preservation, and reserved-name rejection. Golden fixtures must
assert diagnostics where behavior depends on them. The final gate is workspace
typecheck, lint, build, tests, `git diff --check`, then a fresh verifier.

## Non-goals

- Universal `ATTRIBUTE_UNKNOWN` reporting
- Custom block registration or declarative block definitions
- Editor handling of rejected parse results
- Changes to runtime execution or rendering
