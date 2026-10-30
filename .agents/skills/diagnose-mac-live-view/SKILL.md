---
name: diagnose-mac-live-view
description: Use when a Mac task Watch or owner window picture freezes, disappears or fails to reopen.
---

# Diagnose a Mac live view

Read current and rotated Desktop logs. For Beta, start with:

```sh
rg 'computer.display.client|computer-use.video|computer-use.media-ended' "$HOME/Library/Application Support/Opensteer Beta/logs/desktop.log"*
rg 'computer.display.viewer-removed|computer.display.lifecycle' "$HOME/Library/Application Support/Opensteer Beta/logs/personal-host.log"*
rg 'computer.display.relay-ended' "$HOME/Library/Application Support/Opensteer Beta/logs/personal-runner.log"*
```

Use the relevant install's data directory; remote Runner logs stay on that Runner.
Correlate opaque source/view IDs with Host stream IDs and media generations.
Check visibility and retain/release reasons before blaming capture. Hidden demand,
zero viewers, warming and `Display demand ended` indicate loss of visible demand.
A `4002` close plus protocol violation is terminal and deliberately does not retry;
transient closes should schedule retry unless the final viewer left.

For reopen failures, inspect `native-start-error` operation, native domain/code
and helper code. For `producer-stalled`, inspect in-flight work, outstanding bytes
and oldest acknowledgement age to separate encoder saturation from downstream
credit loss. `producer-resumed` ends that episode. No stall warning does not rule
out capture ceasing complete samples; an unchanged window need not emit frames.
Check the first media/relay end reason for buffer limits, socket loss or owner loss.

Preserve content-free IDs and typed reasons in reports. Never add pixels, window
titles, typed input, URLs or native error user-info to diagnostics. Consult
`docs/computer-use.md` for authority and suppression rules before changing recovery.
