# Governance

## Versioning

Opensteer follows Semantic Versioning for documented stable APIs.

## Deprecation Policy

- New stable behavior must be documented before release.
- Breaking changes to stable APIs require a major release.
- Deprecated stable APIs should keep a documented migration path until removal.

## API Admission Rule

Do not add a new stable top-level API without:

- one generic fixture test
- one documented example
- docs that explain engine capability requirements and failure behavior

## Support Defaults

- Public runtime secrets stay in memory unless a caller explicitly persists them.
- Replay registry artifacts cover request plans, recipes, and saved network evidence.
- Evidence capture does not imply response caching.
