# Recorder Reference

Read this file when you need recorder constraints, replay details, or non-default invocation patterns.

## Command

```bash
opensteer record --workspace <id> --url <url> [--output <path>]
```

Useful launch-arg pattern when the value begins with dashes:

```bash
opensteer record --workspace <id> --url <url> --arg=--remote-debugging-port=9333
```

## Stop behavior

- The recorder stops when the user clicks the injected `Stop recording` button in the browser.
- After stop, the CLI writes the replay script and closes the owned browser session.
- Do not use removed timeout flags such as `--record-timeout-ms`.

## What Gets Recorded

- Clicks and double-clicks
- Text entry with idle-based coalescing
- Special key presses such as `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, and arrow keys
- Scroll gestures
- `<select>` value changes
- Same-document navigation via `pushState`, `replaceState`, `popstate`, and `hashchange`
- Full-page navigations, reloads, and back/forward traversal when they can be inferred
- New tabs, closed tabs, and tab switches

## Selector Strategy

- Prefer stable single-attribute selectors such as `data-testid`, `data-test`, `data-qa`, `data-cy`, `id`, `name`, `role`, and `aria-label`
- Reuse the same attribute-priority ordering as Opensteer DOM match policy
- Fall back to short ancestor paths with attribute hints and `:nth-of-type()` when needed
- Require selector uniqueness at capture time

## Generated Replay

- Opens the recorded start URL in the target workspace
- Keeps stable page variables such as `page0`, `page1`, and `page2`
- Activates the correct page before page-scoped SDK actions
- Merges `Enter` into the preceding `input()` call when the capture sequence allows it
- Uses `evaluate()` helpers when replay needs behavior that is not yet exposed as a first-class SDK helper

## Replay verification

- Default generated path: `.opensteer/workspaces/<id>/recorded-flow.ts`
- Typical replay command: `pnpm exec tsx <path-to-recorded-flow.ts>`
- Review the script before replay if the user performed unsupported or approximate browser actions

## Limitations

- v1 records only the top frame
- Cross-origin iframes are not recorded
- Shadow DOM selectors are best effort
- File uploads, drag-and-drop, and canvas interactions are not fully modeled
- Some browser-native key and pointer modifiers are approximated in replay because the public SDK surface is narrower than the raw browser event stream
- Back and forward detection is best effort and may fall back to direct navigation replay in ambiguous cases

## Workflow

1. Start recording with `opensteer record`.
2. Perform the workflow manually in the headed browser.
3. Click the `Stop recording` button in the browser.
4. Wait for the recorder to write `recorded-flow.ts` and close the browser session.
5. Review the generated `recorded-flow.ts`.
6. Run the script with `tsx` or integrate it into a larger automation.
