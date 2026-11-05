# Agent Phones

An Android phone added to Opensteer is used whole: its entire screen, like a person's finger.
`const p = await phone("Pixel")`; `await p.observe()` says whether the screen is on and locked,
which app is in front, and gives the tree. Actions — `tap`, `longPress`, `swipe`, `drag`, `type`,
`clear`, `navigate("back" | "home" | "recents" | "notifications" | "quickSettings")`,
`launch(packageName)`, `scroll`, `wake` — **return the phone's new state**, so the next indices come
from that. A dark screen observes as empty: `await p.wake()`. If locked, ask the person to unlock it; never collect or enter a PIN. One task holds a phone
at a time: `await p.release()` as soon as you are done. Sensitive screens may come back without a
picture or fields; say what you could not see.
