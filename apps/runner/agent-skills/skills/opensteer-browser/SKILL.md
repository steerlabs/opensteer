---
name: opensteer-browser
description: For interactive websites, use Browser Sessions and profiles, or sign in with Chrome. For email, calendar, cloud files, CRM or messaging APIs, try Opensteer integrations first.
---

# Opensteer Browser

Opensteer owns sessions, profile grants, and isolation; Browser Harness handles pages. For account/API work, use `opensteer-integrations` first unless the user chose website interaction or no applicable integration exists.

## Choose a session

Every Browser Session has an ID, and every browser command names the session it drives. `browser_session_open` takes exactly one of `sessionId`, `profileId`, or `fresh: true` and returns the session; `profileId` and `fresh` always start a new one. Identity is fixed when the session opens: to work as another profile, open another session. The optional `environmentId` is placement, not identity: it names the machine whose browser runs the session, defaulting to the machine this Run is on, else the only connected browser.

Choose the identity for each piece of work from what the person asked and what you can observe. One conversation may use several profiles.

- **Work as the person, or work they want kept:** use a profile. `browser_profile_list` lists every profile available here, and no Request is needed for them; pass `site` (such as `brex.com`) to see which profiles hold saved data for a website. Names are labels and saved data is a hint, not proof of an account or a current sign-in: verify the account on the website. Ask the person only when their intent stays ambiguous after looking.
- **A new profile:** when the person asks for one, or names a profile they do not have, call `browser_profile_create` in Main, then open the returned `profile.id` with `browser_session_open` before anyone signs in. In a specialized Workspace, ask with `browser_access_request` and `suggestion: {kind: "new", suggestedName}`; its continuation names the profile to open.
- **Public or throwaway work:** open a Guest session with `fresh: true`. The person sees it as Guest. It can be signed in to websites, but nothing in it is kept when it closes, so never have the person sign in there for work they expect to keep.
- **Continue work:** reuse the session ID from earlier in the Thread, or find it with `browser_session_list` (`attached` marks sessions this Run has open). `browser_tab_read` gives every saved tab's `profileId`, asleep tabs included (null is Guest). An ended session is not listed and does not mean its profile went away: open the profile again.

If creating, getting access to, or opening the profile you need fails, report it. Never continue in Guest instead.

A Run can hold several sessions and use them side by side. Main can see the owner's sessions across Workspaces. Several Runs may use one session; `activeAttachmentCount` is not a lock. Sessions outlive Runs. Close an exact session only when requested or deliberately disposable; delegated Threads cannot close sessions.

## Resolve a missing login

Prefer an intended saved profile that is already signed in. If the profile limit is reached, ask the owner to manage saved profiles; never delete one to make room automatically.

When a page you need shows the user signed out, open its sign-in form in the Browser Session of the profile that should keep the sign-in, then call `sign_in` with `sessionId`, `site`, and a short task reason. It covers the whole site (`github.com` covers `gist.github.com`). An identity provider such as Google or Microsoft may need its own authorization. Saved logins work in fresh and profile-backed sessions; a profile can keep the signed-in state.

- `ready`: use its `loginRef` and masked `account` to sign in in the real tab. Click the username field, then `await fillLogin(loginRef, "username")`. On an identifier-first form, submit or click Next. Click the password field, call `await fillLogin(loginRef, "password")`, then submit. Opensteer fills only the focused field; it does not submit or decide whether sign-in succeeded.
- Handle what the site shows: wait through spinners, choose a method on “verify it’s you”, and tell the person when a push approval needs them. For SMS/email codes, fetch through an available integration and enter with `typeText`, or ask the person to type the code in the visible tab, never in chat. For a saved TOTP, focus its field and call `await fillLogin(loginRef, "code")`. Ask the person to handle CAPTCHA. If the password is wrong, tell them to update it in Opensteer Passwords; do not retry it. Tick Remember Me or “trust this device” when offered and useful for the task. Confirm the intended account on a signed-in page before continuing; do not reload the sign-in URL to check.
- A successful fill returns `"filled"`, meaning only that the value was written. On `no-field` or `stale`, inspect the page and focus the right field. On `wrong-site`, check the focused frame's site and authorize that site if needed. On `expired`, call `sign_in` again. On `denied` or `unavailable`, report the reason; never automatically retry a fill whose answer was lost.
- `applied`: Chrome supplied the sign-in. Reload and confirm the account. Cookie sign-ins do not carry device-bound sessions or site storage; if the site still asks for sign-in, ask the person to sign in in the visible browser.
- `pending`: an approval Request is open. Continue independent work, then end your turn; the Request resumes this Thread. Do not create duplicates; use `request_list` for its state. A Passwords approval continuation carries `loginRef` and `account`; follow the same field-fill flow as `ready`.
- `resolved`: act on the result already delivered. `declined`: continue without the site and do not ask again unless the person asks.
- `not-signed-in` or `unavailable: no-saved-login`: ask the person to sign in in that tab, naming the profile it is in, or to save the login in Opensteer Passwords.
- `unavailable: busy`: another Run's approval is waiting; do independent work and try later. `needs-approval` in a delegated Thread means your assigner must resolve access: finish independent work and end your turn naming the site. Other unavailable reasons explain what stopped access (Passwords off, not set up or not responding, expired authorization, interrupted operation, old runtime, closed session, Chrome restrictions); report them plainly. `not-allowed` means Opensteer itself or a local address.

The same `loginRef` also signs in to that site's genuine app on a phone or Mac (see opensteer-integrations). Never loop on `sign_in`, ask for passwords, MFA codes or recovery answers in chat, or copy cookies or browser state yourself. Opensteer never sends a saved password to you; it fills it into the approved website, where the page can read it.

Opensteer browsers offer websites no passkeys or security keys, so a site that checks for passkey support shows its other sign-in methods; never try to complete a passkey prompt. When a site offers only a passkey, call `sign_in`; if the site still asks for a passkey, tell the user plainly that it needs one, which Opensteer's browser cannot use, and continue without that site unless they sign in another way.

## Profile access and persistence

Profile-backed sessions save their state while in use and when they close; Guest sessions keep nothing. Main inherits every owner profile and creates new empty ones with `browser_profile_create`; it never needs a Request for itself.

`browser_access_request` asks the owner for a profile a specialized Workspace cannot use yet, existing or new; it does not log in. A profile `browser_profile_list` already returns needs no Request. In Main, pass that Workspace's exact `workspaceId`. In a Workspace Thread, omit it. Suggest an existing profile, a new empty profile, or `user_choice`; the owner chooses in the Request surface, and the fulfilled Request names the exact profile. A declined Request leaves the profiles this Workspace already had untouched.

A browser error is about that session, not about profile access: read its message, which says what to do next. Never request profile access because a browser command failed.

When the person already signed in to something in a Guest session and wants to keep it, point them to "Save sign-ins as a profile…" in that tab's menu. It copies those sign-ins once into a new profile; the Guest tab stays Guest, so continue in the new profile.

Name a new profile in one or two words, such as “Work” or “Shopping”, whether you create it with `browser_profile_create` or suggest it with `browser_access_request`.

Use `request_list` for existing Requests and `request_withdraw` when this Thread no longer needs one it originated. Replaying the same tool call returns the same Request; a new call can create another even with identical arguments.

## Page interaction

Use the pinned `OPENSTEER_BROWSER_HARNESS` executable for all page/CDP operations, passing the session ID with `--session`. The Runner supplies the connection. A session with only its initial page needs no tab argument. When several pages are open or the initial page has closed, choose the exact target with `--tab <target ID>` or `await switchTab(targetId)`; `await listTabs()` works without selecting a tab. Report missing executable/connection configuration as a runtime configuration error and other failures as returned. Do not substitute a browser, install another harness, change the CDP endpoint, read local browser profiles, or copy cookies through scripts.

On POSIX shells:

```bash
"$OPENSTEER_BROWSER_HARNESS" --session "$SESSION_ID" <<'JS'
await ensureRealTab();
console.log(JSON.stringify(await pageInfo(), null, 2));
JS
```

On PowerShell:

```powershell
@'
await ensureRealTab();
console.log(JSON.stringify(await pageInfo(), null, 2));
'@ | & $env:OPENSTEER_BROWSER_HARNESS --session $SessionId
```

Open the tabs the task needs; navigate within a tab when you are done with its page. The person sees every tab you leave. To hand the person a page in a particular profile, such as one waiting for their sign-in, leave that tab open in that profile's session and refer to it: pages you used are attached to your reply and open that exact tab. A plain URL in your reply carries no profile; it opens through the person's start page in whatever identity that picks. Keep each tab's `targetId` from `await newTab(url)` or `await currentTab()`, pass it with `--tab` on later invocations, and recover it with `await listTabs()` if needed.

`browser_tab_read` lists every saved tab you can reach, open or asleep, with its group. `browser_tab_write` groups, ungroups, renames or recolours groups, closes tabs and reopens sleeping ones. A saved tab's `tabId` is its Browser Harness `surfaceId`. Groups organize the person's sidebar; they don't change what you can reach.

`move` reorders tabs and groups and moves tabs into or out of groups. Arrange your own tabs as fits the task; leave the person's arrangement alone unless asked.

Put each tab you open where it belongs: in an existing group that fits, in a new group named for your task in a few words if you keep several tabs, or in no group. Close tabs you no longer need, and finish with only the tabs that still matter.

Groups you didn't make and tabs you didn't open are the person's. Rename, ungroup or close them only when the task is about them or the person asks. In a page the person shared or is using, change only what the task needs, and never close its dialogs, clear its fields or navigate it away just to test something; test in your own tab. When asked to organize, group by purpose with names the person would use, and close nothing unless asked.

`newTab(url)` opens nothing when the URL is not HTTP or HTTPS, and closes its tab and fails when the page cannot be reached; a page still loading after 30 seconds fails naming the tab to continue in. When `newTab` brings a session past six tabs, Browser Harness prints one line, such as `[opensteer] This Browser Session has 7 tabs open. …`; close the ones you opened and no longer need.

Pages and conversations are independent: switching your target does not move the person's view, and the person's tab switch never selects your target. A tab your command opens stays behind the person's view; one their own click opens from the page they are viewing comes forward for them. A closed target fails plainly; list the pages and choose explicitly rather than continuing on another page.

A message can include a browser page the person was looking at, as a structured reference with its Browser Session ID and the page's `surfaceId`. In that session, find the tab whose `surfaceId` matches in `await listTabs()` and use its `targetId`. Titles and URLs are descriptive: two tabs can have the same address. If no tab has that `surfaceId`, say the page is gone instead of substituting another page.

```bash
"$OPENSTEER_BROWSER_HARNESS" --session "$SESSION_ID" --tab "$TARGET_ID" <<'JS'
console.log(JSON.stringify(await pageInfo()));
JS
```

## Acting on a page

Each program also gets `page`, a Playwright-style API for the selected tab. Act on elements through locators: `page.getByRole(role, { name })`, `page.getByLabel(text)`, `page.getByText(text)` and `page.locator(css)`, narrowed by chaining another locator, `.first()`, `.last()`, `.nth(i)` or `.filter({ hasText, hasNotText, visible: true })`. A locator describes an element; it holds none. Every action finds its element when it runs and waits up to 10 seconds (`{ timeout }` changes that) until it can act. `click` and `check` scroll the element into view and wait until it is visible, stable, enabled and not covered, then send real mouse input; a visually hidden checkbox or radio is clicked through its visible label. `fill` and `press` focus the field and type into it; date, time, color and range fields and `selectOption` set the value directly and fire `input` and `change`. Elements that re-render or move are found again, and open shadow roots are searched.

Observe, act, then check the page's own result:

```bash
"$OPENSTEER_BROWSER_HARNESS" --session "$SESSION_ID" --tab "$TARGET_ID" <<'JS'
console.log(await page.ariaSnapshot());
await page.getByRole("radio", { name: "512GB" }).check();
const zip = page.getByLabel("ZIP code");
await zip.fill("10014");
await zip.press("Enter");
await page.getByRole("heading", { name: /stores near 10014/i }).waitFor();
console.log(await page.getByRole("radio", { name: "512GB" }).isChecked(), await zip.inputValue());
JS
```

`ariaSnapshot()` prints the accessibility tree as lines such as `- radio "512GB" [checked]`. Its roles and names come from Chromium's accessibility tree, which `getByRole` matches; elements that tree ignores, such as hidden ones, are skipped unless you pass `includeHidden: true`, and their names may be empty. Start with the whole page; on a large page, snapshot a part you saw in it, such as `page.getByRole("dialog", { name: "Pickup" })`. A result larger than one CDP message (432 KiB) fails and asks you to narrow it.

Locators support `click`, `dblclick`, `fill`, `clear`, `press`, `check`, `uncheck`, `setChecked`, `selectOption`, `count`, `textContent`, `innerText`, `allInnerTexts`, `inputValue`, `getAttribute`, `isVisible`, `isChecked`, `isEnabled`, `waitFor({ state })`, `evaluate` and `ariaSnapshot`. `page` supports `goto(url)` (waits for the load event and returns `null`), `url()`, `title()`, `waitForURL`, `waitForFunction`, `waitForTimeout`, `evaluate`, `screenshot({ path })`, `keyboard.press`, `keyboard.type`, `keyboard.insertText` and `mouse.click(x, y)`. Anything else throws and names what exists. Locators do not enter frames.

A finished action means the element passed its checks just before the input was sent, not that the site accepted it; the page can still change in the moment between the two. Check what the site shows before relying on it: `isChecked()`, `inputValue()`, a result that should appear, or a fresh snapshot or screenshot. Wait for that result with `waitFor()`, `waitForURL()` or `waitForFunction()` rather than a fixed delay. A failed action says why: several elements match (it lists them; add a `name`, scope it, or choose with `nth`), nothing matches (a role lookup lists the names it found), or the element is hidden, moving, disabled or covered by the element it names. Change the call rather than repeating it. Browser Harness never repeats a click once its press was sent; an error after that point means the outcome is unknown, so look at the page before acting again.

Key names are Playwright's, such as `Enter`, `Tab`, `Escape`, `ArrowDown`, `Shift+Tab` and `ControlOrMeta+A` (Meta in a browser on a Mac). An unknown name such as `ENTER` throws.

Coordinates (`page.mouse.click(x, y)`, `clickAt`) are for canvas, maps, frames and widgets without usable structure. A coordinate holds only for the layout it was measured in: a scroll, animation, re-render or resize makes it stale, so measure one target right before clicking it. Programs that run again later, such as Trigger programs, find elements with locators and never store coordinates.

The other helpers are `pageInfo`, `listTabs`, `currentTab`, `gotoUrl`, `newTab`, `switchTab`, `closeTab`, `js`, `cdp`, `clickAt`, `typeText`, `fillInput`, `fillLogin`, `pressKey`, `scroll`, `waitForLoad`, `captureScreenshot`, `setInputFiles` and `stageFiles`. `cdp` sends any allowed CDP command when nothing else fits. Use `await` for every call.

To upload, pass files you can read, such as the user's attachments or files you made: `await setInputFiles("input[type=file]", ["/path/photo.png"])` for a file input, or `await setInputFiles({ x, y }, [...])` with the coordinates of a button that opens a file chooser. It returns the files the page now holds; check the page's preview too. The browser may run on another machine, so raw file-bearing CDP (`DOM.setFileInputFiles`, drag `data.files`) accepts only the paths `stageFiles` returns.

Human and agent actions may interleave without a control mode or automatic pause: a script of yours waiting in a page never holds up the person's input, and their input never stops yours. The person can close the session while your script waits; it then fails. `pageInfo`, `currentTab`, and `listTabs` include the latest `userActivity` when the person clicked, scrolled, typed, navigated, or answered a dialog in that page: its `kind`, a timestamp (`at`), coordinates for pointer actions, and `sinceLastAgentCommand`, which is true when the person acted after the last agent command sent to that page. It never contains keys, typed or pasted text, or dialog text. `currentTab` and `pageInfo` read it before sending the page anything. When Browser Harness learns that the person acted in a page since your last command there, on attach or from `currentTab` or `pageInfo`, it prints one line to stderr, once per action, such as `[opensteer] The person clicked in this page 4s ago. Look at the page again before continuing.` It is information, not a pause: look at the page again and choose whether to continue there, wait, or work elsewhere. Do not undo what the person just did there. On the desktop app the person may see and use the page itself; there their scrolling is not reported, and missing activity never proves they did nothing.

A page is the size of the person's view of it, like a browser window: the page they are looking at changes size when they resize their Browser panel. A tab you open starts at the size the panel last had, a tab opened from another at the size its opener shows (an agent's size there included), and a tab the person opens at the size of the view they open it from, such as a phone. `pageInfo` reports the page's `innerWidth` and `innerHeight` as `w` and `h`; under `mobile: true` metrics they follow the page's layout viewport and can differ from the `width` and `height` you set. `pageInfo`, `currentTab`, and `listTabs` include the latest `pageResize` (`width`, `height`, `at`, `sinceLastAgentCommand`, and `agentSizeRemoved` when their fit removed an agent's size); when the person resized a page since your last command there, Browser Harness prints one line, such as `[opensteer] The person resized this page to 840×790 3s ago. Look at the page again before continuing.` Coordinates you measured before it are stale. To use your own size, send `Emulation.setDeviceMetricsOverride`; a zero `width` or `height` keeps following the person's size, and a zero `deviceScaleFactor` keeps the page's own scale. It sizes only that page and stays across Browser Harness runs and navigations until you send `Emulation.clearDeviceMetricsOverride`, which returns the page to the person's size, or the person fits the page to their view. `dontSetVisibleSize` is not supported.

A JavaScript dialog (`alert`, `confirm`, `prompt` or `beforeunload`) stops its page answering any other command until it is answered. An action whose input opens one (`click`, `check`, `press`, `clickAt` and the like) stops at once and throws an error whose `dialog` holds its `id`, `type` and `message`; what the action did is unchecked. `pageInfo`, `currentTab`, and `listTabs` include the open `dialog` (`id`, `type`, `message`), and Browser Harness prints one line about it on attach and when a command times out, such as `[opensteer] This page shows a confirm dialog ("Delete this listing?"); the page answers no other command until the dialog is answered with Page.handleJavaScriptDialog.` Read the dialog, then answer it from this run or a later one with `const { dialog } = await currentTab(); await cdp("Page.handleJavaScriptDialog", { dialogId: dialog.id, accept: true })`, adding `promptText` for a prompt. Opening events from `drainEvents()` carry the same identity as `params.dialogId`. Harness always sends an observed ID, even if you omit it in the answer. The person may answer first; a stale ID fails instead of answering a replacement dialog. Inspect the page again after that failure.

To see a page, use `await captureScreenshot()` or `Page.captureScreenshot`. A viewport screenshot is in input coordinates: its pixel (x, y) is where `page.mouse.click(x, y)` and `clickAt(x, y)` land. A `captureBeyondViewport: true` capture comes at the page's own pixel density instead, which may be 2× on a Retina desktop. A CDP result or event larger than 432 KiB never reaches you: a larger screenshot fails, so send `Page.captureScreenshot` with `format: "jpeg"` or a `clip` instead, and a larger event is dropped without notice. On the desktop app an agent's `Page.startScreencast` shares the picture a viewer is streaming, a JPEG up to twice the page's size, so a large page's frames may never arrive.
