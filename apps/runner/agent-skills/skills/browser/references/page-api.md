# Browser Harness page API

Use the pinned `OPENSTEER_BROWSER_HARNESS` executable for all page operations, passing the session ID with `--session`. The Runner negotiates the backend for that exact session; the CDP API below applies only to CDP sessions. [iPhone pages](#iphone-pages) use typed actions instead. A session with only its initial page needs no tab argument. When several pages are open or the initial page has closed, choose the exact target with `--tab <target ID>` or `await switchTab(targetId)`; `await listTabs()` works without selecting a tab. Report missing executable/connection configuration as a runtime configuration error and other failures as returned. Do not substitute a browser, install another harness, change the endpoint, read local browser profiles, or copy cookies through scripts.

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

Choose reliable locators from observed page structure and verify the site's outcome.

Each program also gets `page`, a Playwright-style API for the selected tab. Act on elements through locators: `page.getByRole(role, { name })`, `page.getByLabel(text)`, `page.getByText(text)` and `page.locator(css)`, narrowed by chaining another locator, `.first()`, `.last()`, `.nth(i)` or `.filter({ hasText, hasNotText, visible: true })`. A locator describes an element; it holds none. Every action finds its element when it runs and waits up to 10 seconds (`{ timeout }` changes that) until it can act. `click` and `check` scroll the element into view and wait until it is visible, stable, enabled and not covered, then send real mouse input; a visually hidden checkbox or radio is clicked through its visible label. `fill` and `press` focus the field and type into it; date, time, color and range fields and `selectOption` set the value directly and fire `input` and `change`. Elements that re-render or move are found again, and open shadow roots are searched.

`ariaSnapshot()` prints the accessibility tree as lines such as `- radio "512GB" [checked]`. Its roles and names come from Chromium's accessibility tree, which `getByRole` matches; elements that tree ignores, such as hidden ones, are skipped unless you pass `includeHidden: true`, and their names may be empty. For a large page, scope the snapshot to a relevant observed part, such as `page.getByRole("dialog", { name: "Pickup" })`. A result larger than one CDP message (432 KiB) fails and asks you to narrow it.

Locators support `click`, `dblclick`, `fill`, `clear`, `press`, `check`, `uncheck`, `setChecked`, `selectOption`, `count`, `textContent`, `innerText`, `allInnerTexts`, `inputValue`, `getAttribute`, `isVisible`, `isChecked`, `isEnabled`, `waitFor({ state })`, `evaluate` and `ariaSnapshot`. `page` supports `goto(url)` (waits for the load event and returns `null`), `url()`, `title()`, `waitForURL`, `waitForFunction`, `waitForTimeout`, `evaluate`, `screenshot({ path })`, `keyboard.press`, `keyboard.type`, `keyboard.insertText` and `mouse.click(x, y)`. Anything else throws and names what exists. Locators do not enter frames.

A finished action means the element passed its checks just before the input was sent, not that the site accepted it; the page can still change in the moment between the two. Check what the site shows before relying on it: `isChecked()`, `inputValue()`, a result that should appear, or a fresh snapshot or screenshot. Wait for that result with `waitFor()`, `waitForURL()` or `waitForFunction()` rather than a fixed delay. A failed action says why: several elements match (it lists them; add a `name`, scope it, or choose with `nth`), nothing matches (a role lookup lists the names it found), or the element is hidden, moving, disabled or covered by the element it names. Change the call rather than repeating it. Browser Harness never repeats a click once its press was sent; an error after that point means the outcome is unknown, so look at the page before acting again.

Key names are Playwright's, such as `Enter`, `Tab`, `Escape`, `ArrowDown`, `Shift+Tab` and `ControlOrMeta+A` (Meta in a browser on a Mac). An unknown name such as `ENTER` throws.

Coordinates (`page.mouse.click(x, y)`, `clickAt`) are for canvas, maps, frames and widgets without usable structure. A coordinate holds only for the layout it was measured in: a scroll, animation, re-render or resize makes it stale, so measure one target right before clicking it. Programs that run again later, such as Trigger programs, find elements with locators and never store coordinates.

The other helpers are `pageInfo`, `listTabs`, `currentTab`, `gotoUrl`, `newTab`, `switchTab`, `closeTab`, `js`, `cdp`, `clickAt`, `typeText`, `fillInput`, `fillLogin`, `fillCard`, `pressKey`, `scroll`, `waitForLoad`, `captureScreenshot`, `setInputFiles` and `stageFiles`. `cdp` sends any allowed CDP command when nothing else fits. Use `await` for every call.

To upload, pass files you can read, such as the user's attachments or files you made: `await setInputFiles("input[type=file]", ["/path/photo.png"])` for a file input, or `await setInputFiles({ x, y }, [...])` with the coordinates of a button that opens a file chooser. It returns the files the page now holds; check the page's preview too. The browser may run on another machine, so raw file-bearing CDP (`DOM.setFileInputFiles`, drag `data.files`) accepts only the paths `stageFiles` returns.

Downloads stay on the device running the browser, not necessarily the computer running this agent.

Human and agent actions may interleave without a control mode or automatic pause: a script of yours waiting in a page never holds up the person's input, and their input never stops yours. The person can close the session while your script waits; it then fails. `pageInfo`, `currentTab`, and `listTabs` include the latest `userActivity` when the person clicked, scrolled, typed, navigated, or answered a dialog in that page: its `kind`, a timestamp (`at`), coordinates for pointer actions, and `sinceLastAgentCommand`, which is true when the person acted after the last agent command sent to that page. It never contains keys, typed or pasted text, or dialog text. `currentTab` and `pageInfo` read it before sending the page anything. When Browser Harness learns that the person acted in a page since your last command there, on attach or from `currentTab` or `pageInfo`, it prints one line to stderr, once per action, such as `[opensteer] The person clicked in this page 4s ago. Look at the page again before continuing.` It is information, not a pause: look at the page again and choose whether to continue there, wait, or work elsewhere. Do not undo what the person just did there. On the desktop app the person may see and use the page itself; there their scrolling is not reported, and missing activity never proves they did nothing.

Observe the current layout before coordinate input, especially after a resize. Change page size only when useful; the person's view can change it too. New tabs inherit the panel's last size, their opener's size, or the view from which the person opens them. `pageInfo` reports layout viewport `w` and `h`, which can differ from requested metrics under `mobile: true`. `pageInfo`, `currentTab` and `listTabs` report `pageResize` with `width`, `height`, `at`, `sinceLastAgentCommand`, and `agentSizeRemoved` when fitting removed an agent override; Harness reports a new person resize on stderr. Earlier coordinates are stale.

`Emulation.setDeviceMetricsOverride` affects one page across Harness invocations and navigations. Zero `width` or `height` follows the person's size; zero `deviceScaleFactor` keeps the page's scale. `Emulation.clearDeviceMetricsOverride`, or the person fitting the page to their view, removes the override. `dontSetVisibleSize` is unsupported.

A JavaScript dialog (`alert`, `confirm`, `prompt` or `beforeunload`) stops its page answering any other command until it is answered. An action whose input opens one (`click`, `check`, `press`, `clickAt` and the like) stops at once and throws an error whose `dialog` holds its `id`, `type` and `message`; what the action did is unchecked. Read the dialog, then answer it with `await respondDialog({ accept: true })`, adding `promptText` for a prompt or `dialogId` for an explicitly observed identity. This works on both backends. Harness sends an observed ID even if you omit it. The person may answer first; a stale ID fails instead of answering a replacement dialog. Inspect the page again afterward. CDP opening events from `drainEvents()` carry `params.dialogId`; actions events carry `dialog.id`. On iPhone, `pageInfo` and `currentTab` report the dialog; the tabs inventory does not.

To see a page, use `await captureScreenshot()` or `Page.captureScreenshot`. Looking never changes the page. A screenshot shows the viewport in input coordinates: its pixel (x, y) is where `page.mouse.click(x, y)` and `clickAt(x, y)` land. There is no full-page capture, because Chromium can only make one by resizing the page a person may be watching: scroll and capture each part, or read the page as text. `captureBeyondViewport: true` and `fromSurface: false` are refused. A `clip` crops the picture: its `x` and `y` are document coordinates as in CDP, its region must lie in what the page shows now, and `scale` is image pixels per CSS pixel. When a page you sized is larger than the view a person is watching, you get the part that view shows, with coordinates still correct; the result then has `cropped` with the `page` and `visible` sizes, and `captureScreenshot` prints a line to stderr. A page holding a JavaScript dialog refuses capture until the dialog is answered. A CDP result or event larger than 432 KiB never reaches you: a larger screenshot fails, so send `Page.captureScreenshot` with `format: "jpeg"` or a `clip` instead, and a larger event is dropped without notice. On the desktop app an agent's `Page.startScreencast` shares the picture a viewer is streaming, a JPEG up to twice the page's size, so a large page's frames may never arrive.

For saved cards, read [cards](cards.md), call `use_card` at checkout, focus each field and call
`await fillCard(cardRef, field)`. Payment fields may be in the provider's iframe on the approved
merchant page. Supported fields are number, expiry, expiry-month, expiry-year, cvc, name and
billing-postal-code. Never read back, print, log, copy or save filled card values to files or memory.
A filled field does not establish payment success; verify the page's confirmation.

## iPhone pages

Taps (including double taps), checks and selects are script-made and untrusted. Verify the site's result; if it refuses script-made taps, say so and ask the person holding the phone to tap it. Don't try a script escape hatch.

Typing uses native insertion, with only `Enter` and `Backspace` as keys: no arbitrary key events, modifiers, Tab, arrows, clipboard or paste actions. Use `fill` to focus and replace a field, then `page.keyboard.press("Enter")`. The current wire cannot focus without filling, so locator `press` and `fillInput(..., { clear: false })` refuse. `cdp`, `js`, page/locator `evaluate`, `waitForFunction` and emulation also refuse with `unsupported-operation`; an update won't change these limits.

`ariaSnapshot()` is a bounded **DOM-derived semantic snapshot**, not an accessibility tree. Literal CSS, role/name, text and label locators support scopes, first/last/nth and text/visibility filters. Regexes, predicates, `includeHidden`, checked-role filters and repeated narrowing of the same scope aren't available. Locators don't enter frames. Password values never come back from reads. Wait with locator `waitFor`, `waitForURL` (an exact HTTP(S) URL) or `waitForLoad`, not a fixed delay. After `stale-document` or `stale-geometry`, Harness refreshes the binding but doesn't repeat the action; inspect again before deciding. Never resend `outcome-unknown` input without checking the result.

Agent uploads need iOS 18.4+ and an admitted native chooser. `stageFiles` returns session-bound file IDs, not phone paths; `setInputFiles` accepts local paths or those IDs with a CSS file-input locator or chooser-button coordinates. Screenshots capture only the viewport without resizing. Suspended tabs refuse until you explicitly `switchTab` to resume that exact tab; watching never resumes it.
