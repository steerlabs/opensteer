# Phones

Two kinds of phone lend their whole screen to `computer_use`, through the same `Phone` handle:

- **Android Agent Phone** (`android-phone`): an Android phone set up over USB with the Agent Phone app.
- **Mac-driven iPhone** (`iphone-screen`): a stock iPhone that one of the person's Macs controls
  over a cable or the same Wi‑Fi. It is its own device with its own approval. Approving the Mac
  never approves the iPhone, and the iPhone never lends you that Mac's apps, files or shell.

Not screens: an Android phone added from the Opensteer mobile app lends only its browser (use
opensteer:browser). The Opensteer iPhone app lends its Calendar, Contacts and Reminders as
plugin tools. That data and the iPhone's screen are separate devices with separate approvals; one
never grants the other.

**Prefer data over a screen.** When a plugin tool can do the job (the iPhone app's Calendar,
Contacts or Reminders, a service's API, the browser), use it. Drive a screen only for what its
interface alone can do.

## Bind

`await phones()` lists visible phones, including blocked ones, each with `name`, `computerId`, `platform`
(`android` or `ios`), `definitionId`, `navigation` (button ids), `actions` and either `access` (`read` or `read-write`) or `blocked: {code,message,next}`. An approved iPhone can also report its `lastKnown` status. Bind and observe to check its state now.
`const p = await phone(nameOrComputerId)` binds one; when two share a name, it lists their
computerIds. `tab(tabId)` binds a phone tab exactly. `computer_list` shows each phone's
`phoneDisplay`, including the Mac driving an iPhone.

## Operate

Look, act, look. `await p.observe()` returns the screen, lock state, foreground app, element tree
and screenshot when available. A Mac-driven iPhone may return only live status (`locked`, `screen`,
and `reason`), with no coordinates for input. The handle's `actions` and `navigation` update after
an observation. Each action returns the phone's resulting observation or status.

- A target is an element index from the tree, or `[x, y]` screenshot pixels. An iPhone's tree is
  often empty: act by screenshot coordinates.
- Send only what the phone advertises: `p.actions` (`tap`, `longPress`, `swipe`, `drag`, `scroll`,
  `type(text, { into })`, `clear`, `wake`, `wait(ms)`, `navigate`, `launch`) and the buttons in
  `p.navigation`. Android offers back, home, recents, notifications and quickSettings. An iPhone
  offers Home and no Back: go back with the app's own on-screen control.
- `launch(appId)` takes an `appId` from `await p.installedApps({ query })` (or `computer_apps`
  with the phone's computerId). It is opaque: never guess a package name or bundle id.
- When what you need is not advertised (an iPhone may lack `type`, `clear` or element indices),
  tell the person what you can't do. Don't improvise around it, such as tapping keyboard keys one
  by one.
- A dark Android screen observes as empty: `await p.wake()`.

## Locked

**iPhone:** ask the person to unlock it themselves. Never type, tap or ask for its passcode, even
when one is offered.

**Android Agent Phone only:** to unlock, wake, open the keypad and enter the screen-lock PIN the
person supplied for this phone, or read the private PIN file they explicitly asked you to keep.
Never repeat the PIN in replies. Never guess, and stop after one rejection. Ask the person only
when the PIN is missing or the controls cannot be observed or used. To retain or locate a saved
PIN, load opensteer:skills and read its references/durable-context.md. This exception is for the
phone's screen lock; app and website passwords use [app sign-in](sign-in.md).

## Unavailable

Check an approved iPhone again when the person says they unlocked or woke it. Use the live result
to decide whether to continue, try another authorized tool that meets the request, or ask the person
for a step only they can take. An unreadable display state is uncertain even when the lock state is
known. Repeating an unchanged check gives you the same information. A Mac-driven iPhone supports
agent screenshots and control when ready. It does not offer a live video view for the person.

| Underlying device reason                                                                                   | Ask the person to                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `locked`                                                                                                   | unlock the iPhone                                                  |
| `not-connected`                                                                                            | connect the iPhone to its Mac with a cable, or join the same Wi‑Fi |
| `driver-offline`                                                                                           | wake the driving Mac and open Opensteer there                      |
| `trust-required`, `developer-mode-required`, `setup-required`, `permission-required`, `helper-unavailable` | finish setup in Opensteer on the named Mac                         |
| `driver-update-required`                                                                                   | update Opensteer on the named Mac                                  |
| `paused`, `protected`                                                                                      | resume the phone or leave the protected screen                     |
| `access-off`                                                                                               | allow Apps (`computer_access_request`, once)                       |

An iPhone whose Mac was disconnected shows Not connected until the person sets it up again on a
Mac. You cannot add, attach or set up a phone; only the person can.

## Finish

One task holds a phone at a time: `await p.release()` as soon as you are done. After
`outcome-unknown`, observe before anything else. When a call says it ended before it was sent,
nothing happened: observe again (binding again if needed) and target from that new observation.
Sensitive screens may come back without a picture or tree; say what you could not see.
