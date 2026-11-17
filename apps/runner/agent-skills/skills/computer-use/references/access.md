# App and phone access

`computer_apps` lists Macs and phones; pass a Mac's
`computerId` to list installed apps in `computer.apps`. Phones include Android Agent Phones and Mac-driven iPhones. `apps()` and `phones()`
also list visible targets, including targets that need access. Each app or phone has either
`access` (`read` or `read-write`) for what this task can do now, or `blocked` with `code`,
`message` and `next`. A connection alone grants no access. Use the row's recommendation
to decide your next step; requests name `app_access_request` with the target's arguments.

Prefer plugin data tools (including Calendar, Contacts and Reminders from the Opensteer iPhone app) over a screen when they can do the job. An iPhone screen has its own approval, separate from its Mac and its data tools.

Which Mac: an app or phone included with the person's message names its computer; use that one.
Otherwise use the Mac the person names. With several Macs and none named, ask: the Mac this task
runs on is not necessarily the one in front of them.

To get an app, call `app_access_request` with the Mac's `computerId` (omit it for the Mac this task
runs on), the app's name or bundle id as `app`, `access` (`read` to see, `read-write` to see and control) and a one-sentence
`reason`. A phone is asked for whole: its own `computerId` without `app`. A Mac-driven iPhone has its
own approval: the Mac's apps being approved never covers it, so ask for the iPhone itself. An app already approved answers at
once, and so does a new app on a Mac that approves apps automatically; otherwise the call waits
for the person and returns the outcome. A pending request grants nothing yet. Its outcome goes to the task that opened it; if another task asked, this task can request access for its own continuation. Automation occurrences receive no continuation. A delegated task can request access within its access ceiling and use `saved_login_request` for
already-authorized sites; see [app sign-in](sign-in.md). An app the person blocked, or one Opensteer
never operates (password managers, terminals, automation tools), stays off limits: say so.

Device switches come before approvals. When a refusal or `computer_list` shows Apps off on an
online phone, ask once with `computer_access_request` (`access: "apps"`) and that phone's
`computerId`. An iPhone's switches are its own: a Mac's Apps switch says nothing about the iPhone it
drives. A disconnected or offline phone cannot be fixed by a request: tell the person what its
blocker says (see [phones](phones.md)) and do not ask again or poll.
