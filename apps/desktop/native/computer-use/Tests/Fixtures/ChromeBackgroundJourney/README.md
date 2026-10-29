# Chrome background regression journeys

Run only in a disposable GUI VM, from a clean committed checkout:

```sh
pnpm test:vm -- --mobile bash -c 'OPENSTEER_RUN_CHROME_BACKGROUND_JOURNEYS=1 OPENSTEER_CHROME_JOURNEY=sweep bash native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/run-vm.sh'
```

`sweep` downloads and verifies official stable Chrome once, then runs R0 first:
AppKit select, Chrome select and Chrome context menu, once, or
`OPENSTEER_CHROME_R0_REPEAT` times (set 5 after a typing or input change). Any R0 regression or invalid setup stops the sweep before later input.
Each repetition has separate evidence. The remaining samples are:

- R1: one fully covered Chrome counter repaint through AXPress, captured with
  `WindowCapture.plan` and `SCStream`. AX advancement and counter-region pixel
  changes must both hold; the animated clock cannot satisfy the check.
- R2: one Chrome sample each for canvas point-click, targeted typing, untargeted typing,
  shortcut and scroll, plus a batch. Each checks the person's front app, key window
  and pointer through the cover's 5 ms telemetry and verifies real receiver effects.
  Point-click requires exactly one canvas event and no AXPress in the receipt.
  The batch explicitly expects `Batchj`: the documented ⌃⌥J limitation inserts
  `j` while delivering the shortcut. Only an otherwise safe exact result is an
  `accepted-limitation`; a future fix changes this assertion.
- R3: overlapping same-process Chrome siblings. Explicit trees, crops and actions
  must stay with their bound window, including exact text and receiver events.
- R4: one Chrome off-Space New Tab batch while the person's cover is full screen.
  It must return the pre-dispatch refusal with no performed actions and leave the
  browser unchanged. The person's exact key stream, front app, key window and
  pointer must hold. This guards the same refusal policy as New Window/Settings.

`R0`, `R1`, `R2`, `R3` and `R4` remain individual selections. Input selections
R2/R3 still run R0 first; R4 runs independently. `all` runs the trimmed set with
one R0 repetition; `acceptance` runs R0, R2 and R3. `OPENSTEER_CHROME_FORCE_AX=1`
is an optional diagnostic browser precondition, recorded separately from default
Chrome behavior.

R0 requires a real menu-level window, the select's own open state where available,
and opening/dismissal within 0.65 s. The numbered global person-key stream must
arrive exactly. The person's front app and pointer must hold; window order permits
only the clicked window's raise, as documented in
[Computer use](../../../../../../../docs/computer-use.md). A key loss under 250 ms
is an `accepted-limitation` only when key status returns, every key arrives and all
other safety checks hold. Longer loss or any other safety failure is a regression.

Evidence is exported under the VM run's `guest/chrome-background/`: `results.json`
(schema 1 rows with `suiteSeconds`), screenshots, AX trees, capture crops, monotonic
telemetry, Chrome identity and cleanup records. Status/verdict values are `pass`,
`accepted-limitation`, `regression` or `invalid`. Missing permissions, missing AX,
setup/build errors and skipped execution never count as passes. Exit 1 means a
regression or invalid row. Inspect every row and the runner log. The parent VM
`job.json` proves VM deletion. The runner stops all invocation-owned processes.

Helium, TextEdit off-Space rows, the separate R3 canvas case and the capture/input Cartesian matrices
are removed. macOS omitting other-Space windows and Chromium's background canvas
input remain documented product limitations in `docs/computer-use.md`.
