# @opensteer/mobile

The Expo client for iPhone and Android. [Opensteer on a phone](../../docs/mobile.md) holds its
lifecycle and authority constraints; the [mobile skill](../../.agents/skills/mobile/SKILL.md) holds
builds, installs and device tests. Expo Go cannot supply this app's native modules or OAuth scheme,
so use a custom client.

[src/config.ts](src/config.ts) owns bundle configuration and [app.config.ts](app.config.ts) owns
native prebuild inputs. Every `EXPO_PUBLIC_*` value is public: never put a secret there. Never set a
development or preview build profile on a build that reaches anyone but developers, because those
profiles allow simulated authentication and Host behavior in Release bundles. A bundle without
`EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN` cannot register Account push or use Connect. Android push
needs the build's private `google-services.json`, which is never committed.
