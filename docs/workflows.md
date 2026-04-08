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

## 3. Replay

1. Use `network.replay(recordId)` to confirm the captured request is reproducible.
2. Let replay auto-select the transport and inspect which transport succeeded.

## 4. Codify

1. Write plain TypeScript with `session.fetch()`.
2. Keep the code as the durable artifact instead of promoting requests into a custom registry.
