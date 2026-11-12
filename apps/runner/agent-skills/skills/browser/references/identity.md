# Profiles and sessions

Choose the identity for each piece of work yourself. Ask the person which profile only when their intent is still ambiguous after looking.

1. **Signed-out or throwaway work** (reading, searching, public pages): open Guest with `browser_session_open {fresh: true}`. Nothing in Guest is kept when it closes, so never have the person sign in there for work they expect to keep.
2. **Work as the person, or work they want kept:** call `browser_profile_list` and open the profile that fits with `browser_session_open {profileId}`. Fit means a profile named for the site or account, the one this Thread already used for the site (`browser_tab_read` shows each tab's profile), or the person's general profile such as Personal or Work. A name never proves a login: check the website, and use `sign_in` if it shows you signed out.
3. **Nothing listed fits:** call `browser_profile_request` with `reason` and `suggestion`, plus an optional `operationKey` for retries. Only the person creates or selects a profile through this Request. Ask when the person wants a new profile or the work needs a separate identity, such as a second account on the same site. Suggest `{kind: "new", suggestedName}` with one or two plain words such as “Brex”, “Work” or “Finance”, or `{kind: "existing", profileId}`.

Profiles belong to the personal owner. Every personal task can use the owner's available profiles. Open an available profile directly, including an existing owner profile whose ID the person supplied. Profile creation and site consent remain the person's decisions.

The call waits for the person and returns the outcome, naming the profile they chose, which may differ from your suggestion: open that one, before anyone signs in. Pending gives no profile; do not poll, repeat or route around the Request. If they decline, carry on without it and do not ask again unless the person brings it up.

## Sessions

`browser_session_open` takes exactly one of `sessionId` (attach to an existing session), `profileId` (a new session as that profile) or `fresh: true` (a new Guest session). Identity is fixed when a session opens; to work as another profile, open another session. A Run can use several sessions side by side.

To continue work, reuse the session ID from earlier in the Thread or find it with `browser_session_list` (`attached` marks sessions this Run has open). `browser_tab_read` gives every saved tab's `profileId`, asleep tabs included; null is Guest. An ended session is not listed, but its profile still exists: open the profile again.

Several Runs may share a session; `activeAttachmentCount` is not a lock. Sessions outlive Runs. Close a session only when asked or when it is deliberately disposable. All tasks use the owner's sessions with their live resource grants and access ceiling.

A profile's home never changes. The listing's `home` names its owning computer and reachability. Open it only on that computer, even when the computer runs no agents. An unavailable home is a reason to reconnect that computer, never to move the profile or substitute another identity. Guest uses an eligible computer in the personal Deployment.

## Failures

A browser error is about that session: read its message, which says what to do next. Never answer a failure by requesting a profile, substituting Guest, or switching profile or computer. “Update this computer to open this profile” needs an update on the profile's computer: report it.

`browser-profile-home-unavailable` names the home device. Tell the person it must reconnect; do not request a new profile or move sign-ins.

Guest sign-ins cannot be saved into a profile. To keep a sign-in, open the right named profile before signing in. Never offer to convert or copy Guest.

Use `pending_request` to see open Requests and `request_withdraw` for one this Thread no longer needs. Replaying the same tool call returns the same Request; a new call can create another.
