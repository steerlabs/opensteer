# Plugin engine import

`vendor/plugin-engine` is generated. Run `pnpm import:plugin-engine <upstream checkout>`
from the repository root to re-import the pinned source and regenerate the notices.

Change copied code through numbered patches in `scripts/plugin-engine/patches` or an overlay.
Keep Opensteer-specific behavior outside the generated tree.
