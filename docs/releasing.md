# Releasing

Opensteer publishes releases from git tags in the `vX.Y.Z` format.

## One-Time Repository Setup

- Add `NPM_TOKEN` to repository Actions secrets.
- Ensure branch protection is enabled for `main` with required checks.

## Release Steps

1. Update `package.json` version and `CHANGELOG.md`.
2. Merge changes to `main`.
3. Create and push a release tag:

```bash
git tag v<version>
git push origin v<version>
```

4. GitHub Actions `release` workflow will:
   - verify tag format and version alignment,
   - build and typecheck,
   - publish to npm with provenance,
   - create GitHub release notes.

## Notes

- The tag must match `package.json` exactly (for example `v0.6.0` for `0.6.0`).
- If needed, you can rerun via `workflow_dispatch` and provide an existing tag.
