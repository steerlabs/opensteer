# Desktop development

Use `pnpm dev` for day-to-day development. To package a local macOS app, first
install the repository's Node and pnpm versions, Go and Xcode command line tools,
run `pnpm install --frozen-lockfile`, and provide these explicit inputs:

| Input         | Environment variables and required layout                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL 17 | `OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE`: distribution directory containing `bin/postgres`, `bin/initdb`, `bin/pg_isready`, `lib/` and `share/`. Include the `dict_snowball` and `plpgsql` modules in `lib/` or `lib/postgresql/`. It must be relocatable, with macOS libraries resolving through `@loader_path` or other relative paths, without external library dependencies. |
| Node          | `OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE`: distribution directory containing `bin/node`, for this Mac's architecture.                                                                                                                                                                                                                                                                 |
| cloudflared   | `OPENSTEER_CLOUDFLARED_BINARY_SOURCE`: executable path; `OPENSTEER_CLOUDFLARED_RELEASE_VERSION`: stable version, at least `2025.4.0`; `OPENSTEER_CLOUDFLARED_BINARY_SHA256`: the executable's lowercase SHA-256 digest.                                                                                                                                                              |

With those variables exported, run:

```sh
pnpm --filter @opensteer/desktop package:mac:contributor
```

The app is written to `apps/desktop/release/contributor/mac-arm64/Opensteer.app` (Apple
Silicon) or `apps/desktop/release/contributor/mac/Opensteer.app` (Intel). This non-release mode
uses development trust and ad-hoc signing, builds the runtime and helpers from
source, and verifies the packaged resources. It requires no signing credentials
or release channel. Agent Phone is omitted unless `pnpm build:agent-phone` has
already produced its APK.

An ad-hoc contributor build runs the workspace. A packaged app refuses unsigned
helpers, so computer use and Opensteer Passwords are unavailable in it. Work on
those features with `pnpm dev`, which trusts the helpers it builds. This command
does not accept a signing input. Signed packages currently come only from
`package:mac`, which also needs release inputs (see [SIGNING.md](SIGNING.md)).

For an arm64 Mac, `pnpm desktop:build-release --unsigned --out /absolute/build-inputs`
fetches pinned public inputs, builds PostgreSQL and the Agent Phone debug APK,
and invokes the same contributor packager through `package:mac --unsigned`.
It needs the Android SDK and JDK as well as the prerequisites above. See
[the local proof](../../docs/releases.md#build-inputs-and-local-proof).
Distribution builds use `package:mac` with the
signing and release inputs described in [SIGNING.md](SIGNING.md).
