# Website sign-in

Prefer an intended saved profile that is already signed in. When a page you need shows the person signed out, sign in in the tab of the profile that should keep it. Call either tool with `tabId`, `site`, and a short task `reason`. Two tools get you in, both after the person's approval; pick by the site and what you've tried, and ask the person only when neither works.

- `copy_chrome_cookies` copies the person's Chrome cookies for the site. Nothing to type, but some sites (often banks) tie a sign-in to the browser it was made in and refuse copies. `copied` means only that cookies arrived: reload the page, since an open one changes only once it loads again. `chrome-signed-out` means no paired Chrome has the site.
- `use_saved_login` uses a login from Opensteer Passwords and signs in fresh, as a person would. Open the site's sign-in form first. On `ready`, focus each field and `await fillLogin(loginRef, "username")` (then `"password"`, or `"code"` for a saved authenticator code), then submit and follow the site's sign-in flow. Saved logins fill websites only in the hosting computer's browser; `main-browser-required` means this tab runs elsewhere. The reference lasts about an hour, so call again to sign back in when a site logs you out mid-task.

Both cover the whole site (`github.com` covers `gist.github.com`); an identity provider such as Google may need its own. Then check you are on the intended account, and finish the work you signed in for before turning elsewhere: sites log idle sessions out.

- `fillLogin` returns `"filled"`, meaning only the value was written. On `no-field` or `stale`, inspect the page and focus the right field; on `wrong-site`, check the focused frame's site; on `expired`, call `use_saved_login` again. Never retry a fill whose answer was lost.
- If the site rejects the saved password, tell the person it needs updating in Opensteer Passwords; do not retry it.
- When the person asked for this sign-in, that covers its SMS or email code unless they said otherwise: retrieve the fresh code through an already-granted integration and type it into the genuine site's challenge. Never repeat or retain it. A push approval, CAPTCHA or code nothing can receive needs the person, in the visible tab, never in chat.
- `pending` means a Request waits for the person and grants nothing yet. `declined`: continue without the site and do not ask again unless the person asks. `busy` or `needs-approval`: name the site and what is missing. Other `unavailable` reasons say what stopped it; report them plainly.

Never ask for passwords, codes or recovery answers in chat, or copy cookies or browser state yourself. Opensteer never sends you a saved value; it fills it into the approved site, where the page can read it.

Passkey support is off by default. When the Host enables it and the browser and viewing Mac support it, a passkey request needs the person's approval and their OS credential manager. Otherwise explain that the person needs a supported viewer or another sign-in method; do not bypass the site's authentication.

The same `loginRef` signs in to that site's genuine app on a phone or Mac (see opensteer:computer-use, references/sign-in.md). For payment cards at checkout, read [cards](cards.md) and use `use_card` with `fillCard`; a card reference never works with `fillLogin` or native typing.
