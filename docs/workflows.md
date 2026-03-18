# Workflows

Opensteer has three standard workflows.

## 1. Browser Action + Network Capture

Use this when you do not yet know the replay shape.

1. Open a real page.
2. Perform the action that triggers the request.
3. Inspect traffic with `queryNetwork()` or `waitForNetwork()`.
4. Save useful evidence with `saveNetwork()`.
5. Promote a captured record into a request plan with `inferRequestPlan()`.

This is the default reverse-engineering workflow.

## 2. Browser-Backed Replay

Use this when a site needs browser cookies, JavaScript-minted tokens, or page-owned execution.

- `context-http`: browser session state matters, but page JavaScript execution does not
- `page-eval-http`: the request must execute inside the live page JavaScript world
- `goto()` + `waitForNetwork()`: observe the page's own request instead of constructing one yourself

Recipes are the standard way to prepare or recover browser-backed state.

## 3. Pure Replay

Use `direct-http` when the target request is replayable without a browser.

This is the lowest-overhead path, but it is not the default assumption for protected
sites. Opensteer treats browser-backed replay as a first-class path, not as a fallback.
