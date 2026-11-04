# Chrome background regression journeys

Real-Chrome checks that background agent input never disturbs the person. Run them only in a
disposable GUI VM, through the [mac-gui skill](../../../../../../../.agents/skills/mac-gui/SKILL.md).

- R0: AppKit select, Chrome select and Chrome context menu. It needs a real menu-level window, the
  select's own open state where available, and opening and dismissal within 0.65 s. The numbered
  person-key stream must arrive exactly, and the person's front app and pointer must hold; window
  order permits only the clicked window's raise. A key loss under 250 ms is an
  `accepted-limitation` only when key status returns, every key arrives and every other safety
  check holds.
- R1: one fully covered Chrome counter repaint through AXPress. AX advancement and counter-region
  pixel changes must both hold; the animated clock cannot satisfy the check.
- R2: Chrome canvas point-click, targeted and untargeted typing, shortcut, scroll and a batch, each
  checked against the person's front app, key window and pointer and real receiver effects.
  Point-click needs exactly one canvas event and no AXPress. The batch expects `Batchj`: the posted
  Control-Option-J limitation in [Computer use](../../../../../../../docs/computer-use.md#background-input-and-its-limits)
  types `j`. A future fix changes this assertion.
- R3: overlapping same-process Chrome windows. Trees, crops and actions stay with their bound
  window, including exact text and receiver events.
- R4: an off-Space New Tab batch while the person's window is full screen. It must be refused
  before dispatch with the browser unchanged and the person's keys, front app, key window and
  pointer intact.

Missing permissions, missing AX, setup errors and skipped execution never count as passes.
