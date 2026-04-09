# Workflows

Opensteer’s default workflow is discovery first, then plain code.

## 1. Capture

1. Open a real page with `open()` or `goto()`.
2. Trigger the relevant page action with `captureNetwork`.
3. Use `network.query()` to scan captured traffic.

## 2. Inspect

1. Use `network.detail(recordId)` on the most relevant request.
2. Check `cookies()`, `storage()`, or `state()` when auth or browser state matters.
3. Use `network.query({ before, after })` to trace dependencies.

## 3. Probe

1. Use `network.detail(recordId, { probe: true })` to inspect transport viability for the captured request.
2. Let the transport probe show which runtime transport is recommended before you write final code.

## 4. Codify

1. Write plain TypeScript with `session.fetch()`.
2. Keep the code as the durable artifact instead of promoting requests into a custom registry.
