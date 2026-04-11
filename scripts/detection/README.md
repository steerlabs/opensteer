# Detection Scripts

These scripts are manual browser-detection probes.

They are intentionally outside `tests/` because they are not part of the
supported `pnpm test` or `pnpm typecheck` path:

- they hit external sites on the public internet
- they require a locally installed Chrome binary
- they are expensive and occasionally nondeterministic

Run them manually when validating stealth-oriented changes:

```bash
pnpm detect:bot
pnpm detect:fetch
pnpm detect:headless
```

The default `CHROME_PATH` in these scripts points at the standard macOS Google
Chrome app bundle. Adjust it locally if your Chrome install lives elsewhere.
