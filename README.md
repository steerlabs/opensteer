# Opensteer

Opensteer is an open-source browser-native reverse-engineering and replay toolkit
for AI agents and humans.

## Packages

- `opensteer`: the public SDK and CLI
- `@opensteer/engine-playwright`: the default Playwright-backed browser engine used by `opensteer`
- `@opensteer/engine-abp`: the optional Agent Browser Protocol engine
- `@opensteer/browser-core`, `@opensteer/protocol`, `@opensteer/cloud-contracts`: shared workspace packages used to keep product, engine, and protocol boundaries explicit

The hosted Opensteer Cloud control plane is intentionally not part of this repository.

## Getting Started

End users can install the SDK and CLI with:

```bash
pnpm add opensteer
pnpm exec playwright install chromium
```

Add `@opensteer/engine-abp` only if you need `--engine abp`.

Contributors working in this monorepo can use:

```bash
pnpm install
pnpm build
pnpm test
pnpm run opensteer:local -- open https://example.com
```

## Repository Layout

```text
packages/
  opensteer/
  engine-playwright/
  engine-abp/
  browser-core/
  protocol/
  cloud-contracts/
docs/
```

Opensteer writes local runtime state under `<cwd>/.opensteer`. That directory is
for local sessions, traces, and artifacts, and should not be committed.

## Documentation

- [Package guide](packages/opensteer/README.md)
- [Documentation index](docs/README.md)
- [Workflow guide](docs/workflows.md)
- [Instrumentation guide](docs/instrumentation.md)
- [Governance](docs/governance.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [License](LICENSE)
