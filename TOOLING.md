# Tooling Policy

- Published packages and runtime entrypoints ship compiled JavaScript from `dist/`.
- Directly executed repository TypeScript entrypoints use `tsx`.
- Root operational scripts that coordinate packaging, publishing, or asset synchronization stay plain `.mjs`.
- Type checking stays separate from execution through the workspace `typecheck` commands.
- `ts-node` is not part of the repository toolchain.

`pnpm run tooling:check` verifies the root and workspace package manifest policy.
