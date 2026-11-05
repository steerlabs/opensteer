# Desktop

The Electron app that bundles a Personal Host, PostgreSQL, Node, cloudflared, a Runner and the
signed macOS helpers. Use `pnpm dev` for day-to-day work.

## Contributor package

To package a local macOS app without signing credentials, install the repository's Node and
pnpm, Go and the Xcode command line tools, run `pnpm install --frozen-lockfile`, and export:

- `OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE`: a relocatable PostgreSQL 17 distribution with
  `bin/postgres`, `bin/initdb`, `bin/pg_isready`, `lib/` (including the `dict_snowball` and
  `plpgsql` modules) and `share/`, whose macOS libraries resolve through `@loader_path` or other
  relative paths.
- `OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE`: a Node distribution with `bin/node` for this Mac.
- `OPENSTEER_CLOUDFLARED_BINARY_SOURCE`, `OPENSTEER_CLOUDFLARED_RELEASE_VERSION` (2025.4.0 or
  newer) and `OPENSTEER_CLOUDFLARED_BINARY_SHA256` (lowercase).

```sh
pnpm --filter @opensteer/desktop package:mac:contributor
```

The app lands in `apps/desktop/release/contributor/mac-arm64/` (Apple silicon) or
`release/contributor/mac/` (Intel). It is ad-hoc signed with development trust and refuses any
signing input. Agent Phone is included only if `pnpm build:agent-phone` already built its APK.

A packaged app refuses unsigned helpers, so computer use and Opensteer Passwords don't work in a
contributor package; work on them with `pnpm dev`, which trusts the helpers it builds. Signed
packages come only from `package:mac` with release inputs; see
[Signing](../../docs/releases.md#signing).

On an arm64 Mac with the Android SDK and JDK, this fetches pinned public inputs, builds
PostgreSQL and the Agent Phone debug APK, and runs the same contributor packager:

```sh
pnpm desktop:build-release --unsigned --out /absolute/directory/outside/the/checkout
```
