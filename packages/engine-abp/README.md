# @opensteer/engine-abp

Agent Browser Protocol engine for Opensteer.

Install this package only when you need `opensteer --engine abp` or when you are
building directly against the engine package.

```bash
pnpm add @opensteer/engine-abp
```

`agent-browser-protocol` downloads its bundled ABP browser during install. In offline
or custom environments, point Opensteer at an existing binary with
`launch.browserExecutablePath` or `ABP_BROWSER_PATH`.
