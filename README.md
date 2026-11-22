# Opensteer

Your Personal Cloud Computer for AI.

Connect a device once. Every AI agent you use can reach your real accounts and devices, only as
far as you allow. Watch it and stop it from your phone.

Agents get stuck at the last step of acting for you: the site that blocks a datacenter address,
the login they don't have, the code sent to your phone, the app on your Mac. Opensteer gives them
your real browser profiles, apps and devices, with your consent, and keeps you in control.

## How it fits together

- **Home.** Where your browser profiles, apps, plugins, tasks and rules live. It runs on your own
  Mac, on a Linux server you run, or on an Opensteer Cloud Computer.
- **Device.** A Mac, a phone or a Cloud Computer, connected once. It always connects out to your
  Home.
- **Agent.** Any AI agent. Agents you already use elsewhere connect with an ordinary sign-in and
  your consent over the Model Context Protocol (MCP). Opensteer also runs your own coding agents on
  your devices.
- **You.** You choose what each agent may use, answer when it needs you, watch it work, and stop
  or disconnect it.

What an agent may do is decided by one rule: what you own, what you granted that agent, the
task's safety mode, the device's switch and the target's own approval, all at once. An agent sees
only what you shared. Anything else looks to it as if it does not exist.

## What works with it

- **Connected agents.** Any MCP client that supports OAuth sign-in. You grant it everything, or
  only some of: tasks for your own agents, browser profiles, Mac apps and phone screens, plugins,
  and Chrome tabs you share. Each of its actions is part of a task you can watch, and you can be
  asked first. See [Connecting an agent](docs/connecting-an-agent.md).
- **Your own agents.** Claude Code, Codex, Cursor, Grok, OpenCode, Pi, Antigravity and Muse Code,
  signed in with the subscriptions you already have, and models on your own hardware. See
  [AI engines](docs/ai-engines.md).
- **Your browser.** Signed-in browser profiles on your Home, and tabs you share from your own
  Chrome with the Opensteer tab sharing extension. See [Browser sessions](docs/browser-sessions.md).
- **Saved logins and cards.** On your Mac, Opensteer fills them into the page when you approve and
  does not return them to the agent. An agent working in that page can read what is on it. See
  [Passwords](docs/passwords.md).
- **Apps and phones.** Approved Mac apps, an Android Agent Phone, and an iPhone screen through
  your Mac.
- **Plugins.** Online services, with account links you review once and can remove. See
  [Plugin accounts](docs/plugin-accounts.md).

## Get started

**On your Mac.** Download Opensteer from
[Releases](https://github.com/steerlabs/opensteer/releases) (macOS 13 or later, Apple silicon).
Open it, connect Chrome and sign in to an agent. Your phone pairs in one scan.

**On Windows.** There's no download yet, so run it from source for now.

**On a Linux server.** Run your own Home on one HTTPS hostname. See
[Opensteer Home on Linux](deploy/home/README.md).

**From source.** Install the Node and pnpm versions in [package.json](package.json), Go and
Docker, then run

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm dev
```

## Security

Your own agents can do what you can do on your computer. New tasks start in Full access, so they
act without asking first. Pick a stricter mode for a task when you want its agent to ask before it
acts. A connected agent starts in Supervised unless you choose otherwise, and gets only what you
granted it. Disconnect ends its access at once, then stops what it started. Opensteer can stop what
happens next, but can't undo what an agent already did.

If you find a security problem, please tell us privately. See [SECURITY.md](SECURITY.md).

## Documents

- [Architecture](docs/architecture.md): how it works, what is guaranteed, and the known limits.
- [Connecting an agent](docs/connecting-an-agent.md): OAuth, grants, tools and results, for
  people building agents.
- [Agent directory](docs/agent-directory.md): what "verified" means at consent.
- [Browser sessions](docs/browser-sessions.md) and [Passwords](docs/passwords.md).
- [AI engines](docs/ai-engines.md) and [Plugin accounts](docs/plugin-accounts.md).
- [Opensteer Home on Linux](deploy/home/README.md) and
  [Cloud Computer operations](docs/cloud-computer-operations.md).
- [Releases](docs/releases.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents should follow [AGENTS.md](AGENTS.md).

## Acknowledgments

Opensteer builds on [T3 Code](https://github.com/pingdotgg/t3code) and other open source
projects. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
