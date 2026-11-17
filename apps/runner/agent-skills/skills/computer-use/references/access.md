# App and phone access

`computer_apps` lists each Mac set up for computer use (its `computerId`, name, state and approval
policy) with its approved apps, and each Agent Phone; call it again with a Mac's `computerId` and an optional `query` to list
its installed apps, each with its `status`, `pending`, `inUse`, `heldByTask` and `callable` facts. Follow response-level `guidance.computers`; compatibility facts `computerToolEnabled` and `computerUseVersion` identify updates needed. A phone's `computerId` lists its apps the same
way; follow `guidance.phones`. When the task names no app ("add this to my calendar"), look at what is installed and ask the
person only if it is genuinely ambiguous. Calendar, Contacts, Reminders and Messages data on an
approved Mac or iPhone is quicker and safer through their plugin tools (`plugin_search`) than by
operating the app; ask for one with `app_access_request` and `dataApp`.

Which Mac: an app or phone included with the person's message names its computer; use that one.
Otherwise use the Mac the person names. With several Macs and none named, ask: the Mac this task
runs on is not necessarily the one in front of them.

To get an app, call `app_access_request` with the Mac's `computerId` (omit it for the Mac this task
runs on), the app's name or bundle id as `app`, `access` (`read` to see, `read-write` to see and control) and a one-sentence
`reason`. A phone is asked for whole: its `computerId` without `app`. An app already approved answers at
once, and so does a new app on a Mac that approves apps automatically; otherwise the call waits
for the person and returns the outcome. Pending grants no access; do not poll, repeat or route
around the Request. A delegated task can request access within its access ceiling and use `saved_login_request` for
already-authorized sites; see [app sign-in](sign-in.md). An app the person blocked, or one Opensteer
never operates (password managers, terminals, automation tools), stays off limits: say so.
