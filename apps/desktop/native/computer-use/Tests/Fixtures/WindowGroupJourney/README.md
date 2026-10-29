# Window-group VM journey

The registered `windows` journey runs `current`, `settle`, `cancellation`, `video`
and `receipt-switch` in both macOS journey variants. `members` and `focus` remain
manual selections; `focus` includes N6. `all` and `review`
were removed. `video` includes passive owner-video termination without a destroy
notification. `receipt-switch` types `canary` and requires username `c`, password
`anary`, and the receipt `Typed 6 characters`. It waits for native key completion
before reading the fields.

Transient AX recovery, posted-event Stop/deadline gates, Tab receipts and unknown
prepared-focus receipts run with host fakes in `FoldedWindowReviewTests`.
Evidence and per-selection `seconds.txt` go under `$OPENSTEER_JOURNEY_OUT`.
