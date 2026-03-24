# Opensteer

Open-source browser automation SDK and CLI that lets AI agents build complex scrapers and custom APIs directly in your codebase.

This repository contains the open-source SDK, CLI, engine packages, shared protocol and cloud contracts, documentation, and first-party agent skills.

## Get Started

```bash
npm i -g opensteer
opensteer skills install
```

If Playwright browser binaries are not installed yet:

```bash
npx playwright install chromium
```

If you are importing Opensteer in application code:

```bash
npm install opensteer
```

## Quick Start

```bash
opensteer open https://example.com --name demo
opensteer snapshot action --name demo
opensteer click 3 --name demo --description "primary call to action"
opensteer snapshot extraction --name demo
opensteer extract --name demo \
  --description "page summary" \
  --schema '{"title":{"selector":"title"},"url":{"source":"current_url"}}'
opensteer close --name demo
```

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "demo",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com");
  await opensteer.snapshot("action");

  const data = await opensteer.extract({
    description: "page summary",
    schema: {
      title: { selector: "title" },
      url: { source: "current_url" },
    },
  });

  console.log(data);
} finally {
  await opensteer.close();
}
```

## Skills

Opensteer ships a first-party skill pack at [skills/opensteer/SKILL.md](./skills/opensteer/SKILL.md) for agents that support the upstream [`skills`](https://skills.sh) ecosystem.

```bash
opensteer skills install
```

List the skills available in this repository without installing them:

```bash
opensteer skills install --list
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
skills/
  opensteer/
docs/
```

- `packages/opensteer`: published SDK and CLI
- `packages/engine-playwright`: default Playwright-backed engine
- `packages/engine-abp`: optional Agent Browser Protocol engine
- `packages/browser-core`, `packages/protocol`, `packages/cloud-contracts`: shared contracts and core primitives
- `skills/opensteer`: first-party Opensteer skill pack for `skills.sh`-compatible agents

This repository includes cloud client code and shared cloud contracts. The managed Opensteer Cloud service is operated separately.

Opensteer writes local runtime state under `<cwd>/.opensteer`. That directory stores local sessions, traces, artifacts, and registry data and should not be committed.

## Documentation

- [Package guide](./packages/opensteer/README.md)
- [Workflow guide](./docs/workflows.md)
- [Instrumentation guide](./docs/instrumentation.md)
- [Governance](./docs/governance.md)
- [Skills guide](./skills/README.md)

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run skills:check
```

## Community

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [License](./LICENSE)
