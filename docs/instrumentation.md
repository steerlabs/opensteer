# Instrumentation

Opensteer owns browser-native observation and execution. It does not own AST
deobfuscation tooling.

## Stable Instrumentation APIs

- `captureScripts()`: collect inline, external, dynamic, and optional worker JavaScript observed in the current run
- `addInitScript()`: patch globals before site scripts execute
- `route()`: continue, fulfill, or abort matching requests
- `interceptScript()`: replace script responses through a script-focused helper built on `route()`

## Engine Compatibility

| Capability          | Playwright | ABP |
| ------------------- | ---------- | --- |
| `captureScripts()`  | Yes        | Yes |
| `addInitScript()`   | Yes        | No  |
| `route()`           | Yes        | No  |
| `interceptScript()` | Yes        | No  |

Unsupported features fail with a structured capability error. Opensteer does not
silently downgrade stable APIs.

## Typical Flow

1. Open the target page.
2. Install `addInitScript()` if you need runtime instrumentation before page code runs.
3. Use `route()` or `interceptScript()` when you need to modify observed behavior.
4. Use `captureScripts()` to persist evidence into the artifact store.
5. Promote what you learned into recipes and request plans.

## Non-Goals

- No built-in AST transform engine
- No bundled Babel or webcrack pipeline
- No WASM interception in the initial standard

Deobfuscation remains an external toolchain problem. Opensteer provides the browser
surface an agent or human uses to observe and validate behavior.
