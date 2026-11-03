# Show the person a Thread or page

Outside an Assignment, if `person_show` is available, use it when the person asks to see a place. On
assigned work, send the exact target and context to your assigner instead; the Host refuses
`person_show` and `person_message` on an Assignment even when both are listed.

For a Thread, find its exact ID with `thread_list` (search and follow its cursor before saying it is
missing), then call `person_show({target: {threadId}})`. For a saved page, search `browser_tab_read`
and use `{target: {tabId}}`; it includes asleep tabs. Switching your own browser target does not
move the person's view.

For “show me what you're doing”, call `person_show({target: {current: true}})`. It opens this Run's
latest tab, Mac app or Agent Phone; no native IDs are needed. If this Run has no current place or
access has ended, report the error instead of substituting a Thread or page.

The request goes to connected devices viewing this conversation in the foreground.
`sent-unconfirmed` reports delivery to N devices, without confirming navigation or that the person
saw it; never say it was shown. On `no-device-connected`, include the Thread link or attach the page
to your reply. Assigned work passes that target and context to its assigner for delivery. An
`already-requested` call is not delivered again. Do not repeatedly send a show request to force
focus.
