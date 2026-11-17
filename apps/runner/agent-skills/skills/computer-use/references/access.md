# App and phone access

`integration_search` for "Computer use" lists each Mac (its `computerId`, name, state and approval
policy) with its approved apps; search again with a Mac's `computerId` and an optional `query` to list
its installed apps, each with its `status`, `pending`, `inUse`, `heldByTask` and `callable` facts. Follow response-level `guidance.computers`; compatibility facts `computerToolEnabled` and `computerUseVersion` identify updates needed. "phone" lists Android Agent Phones and
Mac-driven iPhones the same way, each with its own `computerId`, `definitionId`, `state` and
`approval`; follow `guidance.phones`. When the task names no app ("add this to my calendar"), look
at what is installed and ask the person only if it is genuinely ambiguous. An iPhone's Calendar,
Contacts and Reminders integrations (from the Opensteer iPhone app) are found by searching for
them; prefer them over its screen.

Which Mac: an app or phone included with the person's message names its computer; use that one.
Otherwise use the Mac the person names. With several Macs and none named, ask: the Mac this task
runs on is not necessarily the one in front of them.

To get an app, call `app_access_request` with the Mac's `computerId` (omit it for the Mac this task
runs on), the app's name or bundle id as `app`, `access` (`read` to see, `read-write` to see and control) and a one-sentence
`reason`. A phone is asked for whole: its own `computerId` without `app`. A Mac-driven iPhone has its
own approval: the Mac's apps being approved never covers it, so ask for the iPhone itself. An app already approved answers at
once, and so does a new app on a Mac that approves apps automatically; otherwise the call waits
for the person and returns the outcome. Pending grants no access; do not poll, repeat or route
around the Request. A delegated task can request access within its access ceiling and use `saved_login_request` for
already-authorized sites; see [app sign-in](sign-in.md). An app the person blocked, or one Opensteer
never operates (password managers, terminals, automation tools), stays off limits: say so.

Device switches come before approvals. When a refusal or `computer_list` shows Apps off on an
online phone, ask once with `computer_access_request` (`access: "apps"`) and that phone's
`computerId`. An iPhone's switches are its own: a Mac's Apps switch says nothing about the iPhone it
drives. A disconnected or offline phone cannot be fixed by a request: tell the person what its
availability says (see [phones](phones.md)) and do not ask again or poll.
