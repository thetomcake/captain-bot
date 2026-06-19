<!--
SYNC IMPACT REPORT:
Version: 1.4.0 → 1.4.1 (PATCH: minor prose tightening; structure and rules unchanged)

Modified Principles:
  - II. Test-First: rationale trimmed; "Testing Implementation Standards" condensed
  - V. Code Clarity: rationale condensed

Added Sections: None
Removed Sections: None

Templates Status:
  ✅ plan-template.md - No changes required
  ✅ spec-template.md - No changes required
  ✅ tasks-template.md - No changes required

Follow-up TODOs:
  - Existing src/ comments with bare IDs (T022, US1 etc.) remain non-compliant;
    clean up opportunistically on next touch of each file.

Previous Version (1.3.0 → 1.4.0):
  - V. Code Clarity principle added
  - Governance: Commit Convention added

Previous Version (1.2.0 → 1.3.0):
  - II. Test-First: Testing Implementation Standards subsection added

Previous Version (1.1.0 → 1.2.0):
  - II. Test-First: What to Test / What NOT to Test subsections added

Previous Version (1.0.0 → 1.1.0):
  - III. TypeScript: Module System Requirements subsection added
-->

# Captain Tom Constitution

## Core Principles

### I. CLI-First

Every feature MUST be accessible via command-line interface. CLI tools MUST follow
standard Unix conventions: read from stdin/args, write to stdout, errors to stderr.
Support both human-readable and JSON output formats where appropriate.

**Rationale**: CLI tools are composable, scriptable, and debuggable. Text I/O
ensures transparency and enables integration with other tools.

### II. Test-First (NON-NEGOTIABLE)

Tests MUST be written before implementation. The workflow is:
1. Write tests based on requirements
2. Verify tests fail
3. Implement feature
4. Verify tests pass

#### What to Test

**Business Logic Tests** (PRIMARY):
- Requirements from spec.md (FR-*, SC-* identifiers)
- Data transformations and domain logic
- User-facing behavior and features
- Performance thresholds

**Minimal Output Validation** (SECONDARY):
- One test per output type to ensure readability
- Avoid regex patterns for formatting (brittle)
- Focus on structure, not presentation

#### What NOT to Test

**Library Behavior** (DO NOT TEST):
- Third-party library internals (axios retries, cheerio parsing)
- Framework behavior (process.exit codes, stderr routing)
- Implementation details (regex patterns, formatting logic)
- Placeholder tests with no real assertions

**Rationale**: Tests validate requirements (WHAT), not implementation (HOW).
Library behavior is the library's responsibility. Test-first ensures requirements
are understood before coding begins.

#### Testing Implementation Standards

Detailed guidelines for test implementation, mocking patterns, and test helpers
are in `tests/README.md`. All tests MUST follow the service-boundary mocking
philosophy and use the provided test helper library.

### III. TypeScript

All code MUST be written in TypeScript with strict type checking enabled.
Type definitions MUST be complete and accurate.

**Module System Requirements**:
- Use NodeNext module resolution (`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`)
- All relative imports MUST include `.js` extensions (required by Node.js ESM)
- Use subpath imports (`#src/database/*`, `#src/services/*`, etc.) to avoid deep relative paths
- NEVER use `../../../`-style imports — use the `#src/` prefix defined in package.json

**Rationale**: TypeScript catches errors at compile time, provides better tooling
support, and serves as living documentation. NodeNext ensures compatibility with
modern Node.js ESM. Subpath imports improve maintainability.

### IV. Security-First (NON-NEGOTIABLE)

Security MUST NEVER be compromised to pass tests or meet deadlines. Code MUST be
reviewed for common vulnerabilities (injection, XSS, path traversal, etc.).
Tests MUST NOT use production credentials, bypass authentication, or weaken
security controls.

**Rationale**: Security vulnerabilities can have severe consequences. Proper
security practices from the start prevent costly fixes later.

### V. Code Clarity (NON-NEGOTIABLE)

Code is the authoritative record of system behaviour. It MUST be self-explaining
through naming and structure. Comments and spec references in source are strictly
governed.

#### Comment Rules

Comments MUST explain WHY — a hidden constraint, a non-obvious invariant, a
workaround for a specific external limitation. Comments that explain WHAT the code
does are prohibited; well-named identifiers do that.

The following MUST NOT be committed:
- File-scope summaries that duplicate the filename or module purpose
- Implementation labels (`PURE:`, `Manual entry point:`, phase markers)
- Section separators containing spec, task, or user story identifiers

Section separators are acceptable for navigation in large files but MUST be clean
(e.g., `// ── Connection ───────────────────`).

#### Spec Reference Rules

Spec numbers, task IDs, and user story IDs MUST NOT appear in implementation files
(`src/`). Traceability belongs in git metadata — commit messages, branch names, and
PR descriptions — not in source code.

In test files, `describe`/`it` block names MAY reference spec requirements. When
used, references MUST be fully-qualified: `spec-NNN/US-N` or `spec-NNN/FR-NNN`.
Bare IDs (`US1`, `T022`, `FR-007`) are prohibited everywhere in source.

TODO comments MUST be fully-qualified: `// TODO(spec-NNN/T-NNN): description`.
Bare or ambiguous TODOs (`// TODO(T039)`) are prohibited.

#### Reading Protocol

Code is the primary source of truth. Supporting context exists to resolve ambiguity
— it is NOT consulted routinely. When code is self-evident, stop there.

When clarification is needed, consult in order:
1. **Tests** — describe/it blocks explain what requirements are covered
2. **Git history** — explains why a change was made and which spec it relates to
3. **Spec docs** (`specs/NNN-feature/`) — original intent and historical decisions

Stop at the layer that resolves the question.

**Rationale**: Inline spec references create stale traceability. The git log is
the canonical audit trail; tests are the durable requirement link.

## Governance

This constitution supersedes all other development practices. All code changes
MUST comply with these principles.

**Amendment Process**: Constitution changes require:
1. Documented justification for the change
2. Impact analysis on existing code and practices
3. Update to affected templates and documentation
4. Version increment following semantic versioning

**Versioning**:
- MAJOR: Backward-incompatible changes (removing/redefining principles)
- MINOR: New principles or material expansions
- PATCH: Clarifications and non-semantic refinements

**Commit Convention**: Every commit touching `src/` or `tests/` MUST include the
spec number in the scope field: `type(spec-NNN): description`. This is the primary
traceability mechanism now that source code carries no spec references. Task and
user story references are encouraged in the subject or body — no format prescribed
beyond the spec number.

**Compliance**: Each feature plan MUST include a "Constitution Check" section.
Violations MUST be justified in a Complexity Tracking section.

**Version**: 1.4.1 | **Ratified**: 2026-06-09 | **Last Amended**: 2026-06-19
