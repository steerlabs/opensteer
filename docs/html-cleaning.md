# HTML Cleaning

Snapshot pipeline (`prepareSnapshot`):

1. Mark interactive/hidden/scrollable elements at runtime
2. Serialize page HTML
3. Clean with mode-specific cleaner
4. Assign counters to retained elements and emit counter bindings

Cleaner modes:

- `action`: balanced context for action planning
- `extraction`: richer content for data extraction
- `clickable`: clickable elements only
- `scrollable`: scrollable containers only
- `full`: broad HTML with scripts/styles/noise removed

All modes return compact, LLM-friendly HTML strings.

Counter semantics:

- `c` values are runtime tokens mirrored into each snapshot.
- Unchanged live nodes keep their existing `c` values when possible.
- Every counter action/extraction is validated against the current snapshot
  binding and live node identity.
- Counter resolution is strict: exact match or explicit stale error.
- Boundary wrappers like `os-iframe-root` and `os-shadow-root` may be
  unnumbered.
- Inaccessible iframes and closed shadow roots are not counter-addressable.
