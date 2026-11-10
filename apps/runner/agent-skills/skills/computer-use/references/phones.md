# Agent Phones

An Agent Phone, set up over USB with the Agent Phone app, lends its whole screen. An Android phone
added from the Opensteer mobile app lends only its browser, not its other apps or screen; use
opensteer:browser for that. `phones()` lists only Agent Phones.
`const p = await phone("Pixel")`; `await p.observe()` says whether the screen is on and locked,
which app is in front, and gives the tree. Actions — `tap`, `longPress`, `swipe`, `drag`, `type`,
`clear`, `navigate("back" | "home" | "recents" | "notifications" | "quickSettings")`,
`launch(packageName)`, `scroll`, `wake` — **return the phone's new state**, so the next indices come
from that. A dark screen observes as empty: `await p.wake()`.

To unlock, wake, open the keypad and enter the screen-lock PIN the person supplied for this phone,
or read the private PIN file they explicitly asked you to keep. Never repeat the PIN in replies.
Never guess, and stop after one rejection. Ask the person only when the PIN is missing or the controls cannot be observed or used.
To retain or locate a saved PIN, load opensteer:skills and read its references/durable-context.md.
This exception is for the phone's screen lock; app and website passwords use [app sign-in](sign-in.md).

One task holds a phone at a time: `await p.release()` as soon as you are done. Sensitive screens may
come back without a picture or fields; say what you could not see.
