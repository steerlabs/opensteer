# Restore a Personal database snapshot

Only for a person restoring their own Deployment, or on a disposable root; never Tim's live install.
Snapshots live in `<deploymentRoot>/snapshots/<UTC>-<fromVersion>/`; only one with `snapshot.json`
is complete, and the newest three are kept.
[personal-database-snapshot-journey.ts](../../../../apps/desktop/scripts/personal-database-snapshot-journey.ts)
performs these steps:

1. Quit Opensteer so PostgreSQL stops.
2. Rename the PostgreSQL data directory to `<data>.before-restore`.
3. `cp -cRp <snapshot>/postgres <data>`.
4. Set the Personal deployment manifest's `release` to `fromRelease` from `snapshot.json`.
5. Start the older release.

Snapshots exclude native browser storage
([what a restore covers](../../../../docs/releases.md#personal-database-snapshots)).
