# Profiles

Every tab browses as an identity: a named profile or Guest. A tab you switch to keeps its own identity (`profile` in `listTabs`); you choose one only when you open a new tab. Ask the person which profile only when their intent is still ambiguous after looking.

1. **Signed-out or throwaway work** (reading, searching, public pages): `newTab(url, { guest: true })`. This task's Guest browser keeps nothing when it closes, and other tasks never share it, so never have the person sign in there for work they expect to keep.
2. **Work as the person, or work they want kept:** call `browser_profile_list` and open the profile that fits with `newTab(url, { profile })`. Fit means a profile named for the site or account, the one this task or the person already uses for the site (`listTabs` shows each tab's profile), or the person's general profile such as Personal or Work. A name never proves a login: check the website, and sign in (see [sign-in](sign-in.md)) if it shows you signed out.
3. **Nothing listed fits:** call `browser_profile_request` with `reason` and `suggestion`, plus an optional `operationKey` for retries. Only the person creates or selects a profile through this Request. Ask when the person wants a new profile or the work needs a separate identity, such as a second account on the same site. Suggest `{kind: "new", suggestedName}` with one or two plain words such as “Brex”, “Work” or “Finance”, or `{kind: "existing", profileId}`.

Profiles belong to the personal owner, and every personal task can use the owner's available profiles, including one whose ID the person supplied. Profile creation and site consent remain the person's decisions. A profile's tabs share one browser: other tasks and the person may be using it at the same time.

The request waits for the person and returns the outcome, naming the profile they chose, which may differ from your suggestion: open that one, before anyone signs in. Pending gives no profile; do not poll, repeat or route around the Request. If they decline, carry on without it and do not ask again unless the person brings it up.

A profile's home never changes. `browser_profile_list` names its home computer and whether it is reachable. A profile opens only there, even when that computer runs no agents. An unavailable home is a reason to reconnect that computer, never to move the profile or substitute another identity. Guest uses an eligible computer in the personal Deployment.

## Failures

A browser error is about that tab or its browser: read its message, which says what to do next. Never answer a failure by requesting a profile, substituting Guest, or switching profile or computer. “Update this computer to open this profile” needs an update on the profile's computer: report it. An offline home names the computer; tell the person it must reconnect.

Guest sign-ins cannot be saved into a profile. To keep a sign-in, open the right named profile before signing in. Never offer to convert or copy Guest.

Use `pending_request` to see open Requests and `request_withdraw` for one this Thread no longer needs. Replaying the same tool call returns the same Request; a new call can create another.
