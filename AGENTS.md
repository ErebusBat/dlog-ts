# dlog-ts

## Product contract

This project is a TypeScript implementation of the local `dlog` daily-log CLI.

- [`docs/specification.md`](docs/specification.md) defines the observable behavior to preserve.
- [`docs/conformance.md`](docs/conformance.md) defines deterministic, user-visible conformance cases. Turn relevant cases into executable tests as each feature is implemented.
- Preserve behavior such as ordered literal and regular-expression substitutions, callback semantics, external-tool invocation, local-time handling, byte-level document normalization, and watcher behavior.
- Treat the Ruby implementation only as behavioral evidence. Ruby configuration syntax, filenames, dynamic evaluation, DSL mechanics, and Ruby-specific conventions are not compatibility requirements.

## TypeScript-native configuration

Configuration is a deliberate TypeScript design boundary, not a Ruby port.

When a requirement would copy Ruby mechanics rather than preserve an observable behavior—for example `.rb` configuration, runtime evaluation, DSL blocks, implicit conversion, or shell-derived configuration semantics—stop and discuss the TypeScript-native design with the user before implementing it. State the behavior that must remain compatible and propose an explicit TypeScript alternative.

Do not add a Ruby configuration parser, evaluator, compatibility adapter, or configuration shim unless the user explicitly asks for one. Keep the portable configuration schema, discovery rules, validation, and plugin/external-command contracts explicit and testable.

## Implementation standards

Follow the `maintainable-typescript` skill:

- Organize code around stable feature owners, not generic helper layers. Edit the owner of a behavior; delete obsolete paths during a clean cutover.
- Keep one canonical named type and validation contract for each boundary. Validate untrusted configuration, files, command output, and process inputs at the boundary; keep internal code strongly typed without casts or optional fallbacks.
- Avoid barrel exports, compatibility aliases, re-exports, speculative abstractions, and magic values. Prefer a deep module with a clear public contract.
- Model substitutions, callback return states, and external-command results as explicit discriminated TypeScript types. Preserve registration order and duplicate-key rules.
- Isolate filesystem, clock, process, clipboard, and network access behind real feature-owned boundaries. Tests may mock those external boundaries, not internal behavior.
- Prefer safer process APIs to shell evaluation. If shell semantics would change an observable external-tool contract, stop and discuss the compatibility and safety tradeoff before choosing an implementation.

## Commits

- Create small, maintainable commits continuously: each commit owns one coherent, verified behavioral change.
- Include the implementation, affected contract tests, and required documentation or cleanup in that same commit. Keep unrelated refactors, formatting, and generated-file churn out of it.
- Before committing, run the narrow affected test and the project type check. Never commit a knowingly failing contract.
- Stage only the change the commit owns; preserve unrelated work already present in the working tree.

## Testing and verification

- Test observable outcomes: CLI status/stdout/stderr, persisted document bytes, command invocation/output/status, and watch state transitions.
- Use controlled clocks, temporary existing files, and executable fixtures for deterministic behavior. Test the specified quirks where they are observable; do not “correct” them accidentally.
- Add or update the relevant conformance coverage with every behavior change. Run the narrow affected test and the project type check before claiming completion.
- Use the commands declared in `package.json`; do not duplicate their implementation details here.
