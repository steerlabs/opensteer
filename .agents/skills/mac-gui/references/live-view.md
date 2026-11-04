# Diagnose a frozen Mac live view

Read current and rotated logs in the affected install's data directory, read-only; a remote Runner's
logs stay on that Runner.

```sh
logs="$HOME/Library/Application Support/Opensteer/logs"
rg 'computer.display.client|computer-use.video|computer-use.media-ended' "$logs"/desktop.log*
rg 'computer.display.viewer-removed|computer.display.lifecycle' "$logs"/personal-host.log*
rg 'computer.display.relay-ended' "$logs"/personal-runner.log*
```

Correlate opaque source and view IDs with Host stream IDs and media generations. Check visibility
and retain and release reasons before blaming capture: hidden demand, zero viewers, warming and
`Display demand ended` mean visible demand was lost. A `4002` close with a protocol violation is
terminal and not retried; transient closes retry unless the last viewer left.

For reopen failures, inspect the `native-start-error` operation, native domain and code, and helper
code. For `producer-stalled`, compare in-flight work, outstanding bytes and oldest acknowledgement
age to separate encoder saturation from lost downstream credit; `producer-resumed` ends it. No stall
warning does not rule out ScreenCaptureKit ceasing complete samples, and an unchanged window need
not emit frames. Check the first media or relay end reason for buffer limits, socket loss or owner
loss.

Report content-free IDs and typed reasons only: never pixels, window titles, typed input, URLs or
native error user-info.
