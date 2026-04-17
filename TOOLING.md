# Tooling Policy

- Published packages and runtime entrypoints ship compiled JavaScript from `dist/`.
- Root `package.json` scripts that execute repository TypeScript entrypoints use `tsx`.
- Root operational scripts that coordinate packaging, publishing, or asset synchronization stay plain `.mjs`.
- Type checking stays separate from execution through the workspace `typecheck` commands.
- `ts-node` is not part of the repository toolchain.
- Root scripts prefer `tsx ...` over `node --import tsx ...` for consistency; this is a repository rule, not a `tsx` limitation.

`pnpm run tooling:check` verifies these dependency bans and root script conventions.
