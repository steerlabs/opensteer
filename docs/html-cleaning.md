# HTML Cleaning

Snapshot pipeline (`prepareSnapshot`):

1. Mark interactive/hidden/scrollable elements at runtime
2. Serialize page HTML
3. Clean with mode-specific cleaner
4. Assign counters to retained elements and sync the same counters to live DOM nodes

Cleaner modes:

- `action`: balanced context for action planning
- `extraction`: richer content for data extraction
- `clickable`: clickable elements only
- `scrollable`: scrollable containers only
- `full`: broad HTML with scripts/styles/noise removed

All modes return compact, LLM-friendly HTML strings.

Counter semantics:

- `c` values are assigned fresh on every snapshot pass.
- The snapshot HTML and live DOM are synchronized to the same `c` values.
- Counter resolution reads live DOM by `c` only (no snapshot session binding).
- Action lookup uses strict unique match:
  - no match -> target not found
  - multiple matches -> target ambiguous
- Extraction lookup is tolerant:
  - no match -> field value is `null`
  - multiple matches -> extraction fails as ambiguous
- Boundary wrappers like `os-iframe-root` and `os-shadow-root` may be
  unnumbered.
- Inaccessible iframes and closed shadow roots are not counter-addressable.
