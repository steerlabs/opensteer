# Show the person a task or page

Outside a delegation, show work without being asked: the moment a place they asked for, or must act on, is ready, and again when the work moves somewhere else they need. Skip what you only read to answer them. On a delegation, `queue` the place and why it matters to the delegating task, which shows it; the Host refuses `show_to_person` and `send_to_person` there.

Targets for `show_to_person`:

- Your own work, or "show me what you're doing": `{current: true}`. This Run's latest tab, Mac app or Agent Phone; no native IDs.
- A task's work: `{runId}`. Take `runId` from `recentPlaces` in `opensteer_task_read`, and read it again when the task says it moved. A place is recent, not proof it is open: if its tab has closed, say so and never substitute.
- Any browser tab: `{tabId}` from Browser Harness `listTabs()`, including asleep tabs.
- A task: `{taskId}` from `opensteer_task_list`; search and follow its cursor before saying it is missing.

Switching your own browser target does not move the person's view. If a target fails, report the error instead of substituting.

The request goes to devices with this task on screen or beneath the place on screen. `sent-unconfirmed` reports delivery to N devices, not navigation or viewing: never say it was shown. On `no-device-connected`, include the task link or attach the page to your reply. `already-requested` was not delivered again. Do not repeat a show to force focus.
