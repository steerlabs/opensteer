# Profiles and sessions

Every Browser Session has an ID, and every browser command names the session it drives. `browser_session_open` takes exactly one of `sessionId`, `profileId`, or `fresh: true` and returns the session; `profileId` and `fresh` always start a new one. Identity is fixed when the session opens: to work as another profile, open another session. A profile's computer is permanent after first open. The optional `environmentId` chooses placement only for an unplaced profile or Guest, defaulting to this Run's machine, else the only connected browser; it cannot move an existing profile or choose identity.

Choose the identity for each piece of work from what the person asked and what you can observe. One conversation may use several profiles.

- **Work as the person, or work they want kept:** use a profile. `browser_profile_list` lists every profile available here without a Request; the list provides identities and grants. A name never proves an account or current login; verify on the website. Ask the person only when their intent stays ambiguous after looking.
- **A profile you cannot use yet:** only the person creates profiles and grants them. Call `browser_profile_request` when the person asks for a new profile, names one they do not have, or the work needs a separate identity none of the listed profiles fits; in a Project, also when it needs a profile only Main can use. Suggest `{kind: "new", suggestedName}` or `{kind: "existing", profileId}`. The person may pick another profile or name, then the continuation names the profile to open; use that one. Open it before anyone signs in.
- **Public or throwaway work:** open a Guest session with `fresh: true`. The person sees it as Guest. It can be signed in to websites, but nothing in it is kept when it closes, so never have the person sign in there for work they expect to keep.
- **Continue work:** reuse the session ID from earlier in the Thread, or find it with `browser_session_list` (`attached` marks sessions this Run has open). `browser_tab_read` gives every saved tab's `profileId`, asleep tabs included (null is Guest). An ended session is not listed and does not mean its profile went away: open the profile again.

If getting or opening the profile you need fails, report it; never substitute Guest. “Update this computer to open this profile” requires an update on its owning computer. Never work around that refusal by creating another profile, choosing another computer or substituting Guest.

A Run can hold several sessions and use them side by side. Main can see the owner's sessions across Workspaces. Several Runs may use one session; `activeAttachmentCount` is not a lock. Sessions outlive Runs. Close an exact session only when requested or deliberately disposable. Delegated Runs use the same tools within inherited reach and resource grants.

Named profiles keep browser data on their owning computer; Guest keeps nothing. A new profile may stay unplaced until first open. Main can use every owner profile without a Request.

`browser_profile_request` asks the person for a profile; it does not log in. A profile `browser_profile_list` already returns needs no Request: open it. Omit `workspaceId` for this Workspace; from Main, pass a Project's exact `workspaceId` to ask on its behalf. Suggest an existing profile, a new one, or `user_choice`; the person chooses, and the fulfilled Request names the exact profile. A declined Request leaves the profiles this Workspace already had untouched; carry on without one and do not ask again unless the person does.

A browser error is about that session, not about profile access: read its message, which says what to do next. Never request profile access because a browser command failed.

Guest sign-ins cannot be saved as a profile. To keep a sign-in, create or choose a named profile before signing in. Never offer conversion, copying, or a Guest-save action.

Suggest a new profile's name in one or two plain words, such as “Personal”, “Work” or “Finance”.

Use `request_list` for existing Requests and `request_withdraw` when this Thread no longer needs one it originated. Replaying the same tool call returns the same Request; a new call can create another even with identical arguments.

Use `browser_profile_request` only if listed for this Run. Delegated tasks inherit their root’s reach and can request missing access within it. A specialist’s bindings may narrow the result.
