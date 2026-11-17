# App and phone access

`integration_search` for "Computer use" lists Macs and their apps; search with a Mac's
`computerId` to list installed apps. "Android phone" lists phones. `apps()` and `phones()`
also list visible targets, including targets that need access. Each app or phone has either
`access` (`read` or `read-write`) for what this task can do now, or `blocked` with `code`,
`message` and `next`. A connection alone grants no access. Use the row's recommendation
to decide your next step; requests name `app_access_request` with the target's arguments.

Which Mac: an app or phone included with the person's message names its computer; use that one.
Otherwise use the Mac the person names. With several Macs and none named, ask: the Mac this task
runs on is not necessarily the one in front of them.

To get an app, call `app_access_request` with the Mac's `computerId` (omit it for the Mac this task
runs on), the app's name or bundle id as `app`, `access` (`read` to see, `read-write` to see and control) and a one-sentence
`reason`. A phone is asked for whole: its `computerId` without `app`. An app already approved answers at
once, and so does a new app on a Mac that approves apps automatically; otherwise the call waits
for the person and returns the outcome. A pending request grants nothing yet; you will be told when the owner answers. A delegated task can request access within its access ceiling and use `saved_login_request` for
already-authorized sites; see [app sign-in](sign-in.md). An app the person blocked, or one Opensteer
never operates (password managers, terminals, automation tools), stays off limits: say so.
