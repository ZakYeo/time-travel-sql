# Development

Use the Node version in `.nvmrc`, then `npm ci`. Install the pinned Semgrep CLI
using `uv tool install semgrep==1.170.0` or a Python virtual environment
with `python -m pip install -r requirements-dev.txt`. Semgrep is a development
tool only, never an application runtime dependency.

Run `npm run hooks:install` once and `npm run hooks:check` to verify Git uses the
checked-in executable hooks. Both pre-commit and pre-push run `npm run check`,
including dependency-cruiser and Semgrep. Commit messages use Conventional Commits.
Hooks check without rewriting or stashing files, preserving partial staging.

`npm run architecture` enforces dependency direction and public import boundaries.
Executable positive/negative fixtures prove domain purity, browser separation,
adapter isolation and type-only ports. `npm run semgrep` runs the local ruleset:
unchecked JSON casts, double assertions, swallowed errors, executable strings
and ambient runtime state in the SDK are rejected. `npm run semgrep:test` validates
rule fixtures. These rules complement graph enforcement and strict type checking.

Semgrep uses only checked-in rules, temporary local settings, no account token,
metrics or version checks. Missing tools and scan errors fail the gate.
The rules target specific regressions; independent review remains necessary for
cohesion, branching complexity and abstractions that static analysis cannot judge.

`npm run test:query-policy` runs four pinned in-memory PGlite feasibility tests,
including an owned worker termination probe. It is included in `npm run check`
and both hooks. These tests establish engine evidence; production historical SQL
and comprehensive resource bounds remain pending.
