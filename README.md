# Opensteer

Opensteer turns your computer into an AI agent workstation you can steer from
your phone.

> **Early alpha.** Expect rough edges, and please don't rely on it for anything
> critical yet. See [Security](#security).

- **Bring your own agents.** Claude Code, Codex, Cursor, OpenCode and Pi, signed
  in with the subscriptions you already have, or models running on your own
  machine. No API bills required.
- **Runs on your computer.** Your files, accounts and data stay with you.
- **Work from anywhere.** Your phone and your other computers connect to it.
- **Agents work alongside you,** in your browser, your apps and your computer.

## Getting started

Our goal is simple: install it, connect your devices, and go. We're not there
yet. For now you build it from source, and a one-click download is coming.

Install the Node and pnpm versions declared in [package.json](package.json), Go,
and Docker. Then run:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm dev
```

`pnpm setup:local` checks prerequisites, prepares local services and installs the
Chromium that the tests drive. Native desktop and mobile builds also need their
platform toolchains; see [apps/desktop](apps/desktop/README.md) and
[apps/mobile](apps/mobile/README.md).

To run your own server instead, follow the
[self-hosting guide](deploy/self-host/). Compose builds the images locally;
configure credentials and public origins before starting services.

## Why we're building this

We think you should be able to do real work from anywhere: from your phone today,
and eventually from new kinds of devices like AR/VR glasses, using your voice or
gestures. Agents do the heavy lifting while everything keeps running on your
computer. Your work and your data stay yours.

I strongly believe that, for most things, the future is running your own stuff
locally. So we don't plan to offer a cloud-hosted version, even though you'll
find bits of the code that suggest one. That was our original plan, and we
changed our minds. For genuinely compute-heavy work a cloud machine still makes
sense, and it should be easy to connect one or host your own.

## Security

We can't guarantee security yet, but we take it seriously. We review changes
carefully and run automated security scans with Codex Security and Daybreak. If
you find a problem, please tell us privately. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Opensteer is inspired by
[T3 Code](https://github.com/pingdotgg/t3code); see
[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).

## License

[MIT](LICENSE)
