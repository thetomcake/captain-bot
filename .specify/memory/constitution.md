<!--
SYNC IMPACT REPORT:
Version: 1.0.0 → 1.1.0 (MINOR: Added module system requirements to TypeScript principle)

Modified Principles: 
  - III. TypeScript - Added Module System Requirements subsection
    * NodeNext module resolution mandate
    * .js extension requirement for ESM imports
    * Subpath imports requirement to avoid deep relative paths

Added Sections: None

Templates Status:
  ✅ plan-template.md - Constitution Check section confirmed compatible
  ✅ spec-template.md - Aligned with test-first methodology
  ✅ tasks-template.md - Task structure supports test-first workflow

Follow-up TODOs: None
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

**Rationale**: Test-first development ensures requirements are understood before
coding begins and provides immediate feedback on correctness.

### III. TypeScript

All code MUST be written in TypeScript with strict type checking enabled.
Type definitions MUST be complete and accurate.

**Module System Requirements**:
- Use NodeNext module resolution (`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`)
- All relative imports MUST include `.js` extensions (required by Node.js ESM)
- Use subpath imports (`#src/database/*`, `#src/services/*`, etc.) to avoid deep relative paths (`../../../`)
- Never use `../../../` style imports - use the `#src/` prefix (maps to `src/` root) defined in package.json

**Rationale**: TypeScript catches errors at compile time, provides better tooling
support, and serves as living documentation. NodeNext ensures compatibility with
modern Node.js ESM. Explicit extensions prevent runtime module resolution errors.
Subpath imports improve maintainability and readability.

### IV. Security-First (NON-NEGOTIABLE)

Security MUST NEVER be compromised to pass tests or meet deadlines. Code MUST be
reviewed for common vulnerabilities (injection, XSS, path traversal, etc.).
Tests MUST NOT use production credentials, bypass authentication, or weaken
security controls.

**Rationale**: Security vulnerabilities can have severe consequences. Proper
security practices from the start prevent costly fixes later.

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

**Compliance**: Each feature plan MUST include a "Constitution Check" verifying
alignment with these principles. Violations MUST be justified in a Complexity
Tracking section.

**Version**: 1.1.0 | **Ratified**: 2026-06-09 | **Last Amended**: 2026-06-11
