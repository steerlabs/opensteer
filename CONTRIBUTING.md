# Contributing

Use the tool versions in [package.json](package.json) and follow
[README.md](README.md) for setup. Work on a branch and open a focused pull
request on [steerlabs/opensteer](https://github.com/steerlabs/opensteer) with the
problem, resulting behavior and validation. Reproduce bugs before changing code.
The required `Check` must pass; pull requests are squash-merged.

Run checks covering your change as described in [Testing](docs/testing.md).
GUI journeys run in the supported macOS test environment. Keep documentation near
its owner and report checks you could not run. Coding agents should follow
[AGENTS.md](AGENTS.md).

For a local macOS app without signing credentials, see the
[Desktop contributor package](apps/desktop/README.md).

By contributing, you agree your contribution is licensed under the MIT license.
