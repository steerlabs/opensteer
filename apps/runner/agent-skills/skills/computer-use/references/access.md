# App and phone access

`integration_search` for "Computer use" lists each Mac (its `runnerId`, name, state and approval
policy) with its approved apps; search again with a Mac's `runnerId` and an optional `query` to list
its installed apps, each with its `status`, `pending`, `inUse`, `heldByThread` and `callable` facts. Follow response-level `guidance.computers`; compatibility facts `computerToolEnabled` and `computerUseVersion` identify updates needed. "Android phone" lists phones the same
way; follow `guidance.phones`. When the task names no app ("add this to my calendar"), look at what is installed and ask the
person only if it is genuinely ambiguous.

Which Mac: an app or phone included with the person's message names its computer; use that one.
Otherwise use the Mac the person names. With several Macs and none named, ask: the Mac this task
runs on is not necessarily the one in front of them.

To get an app, `integration_request` with `kind: "computer-app"`, the Mac's `runnerId`, the app's
name or bundle id, `access` (`read` to see, `read-write` to see and control) and a one-sentence
`reason`. A phone is asked for whole: same request without `app`. An app already approved answers at
once, and so does a new app on a Mac that approves apps automatically; otherwise the call waits
for the person and returns the outcome. Pending grants no access; do not poll, repeat or route
around the Request. A delegated task can request access within its access ceiling and use `use_saved_login` for
already-authorized sites; see [app sign-in](sign-in.md). An app the person blocked, or one Opensteer
never operates (password managers, terminals, automation tools), stays off limits: say so.
