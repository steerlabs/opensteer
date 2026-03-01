# Opensteer SDK API Reference

The SDK is the `Opensteer` class imported from `'opensteer'`. **Only the methods listed below exist.** Do NOT call CLI command names as SDK methods.

## Construction and Lifecycle

```typescript
const opensteer = new Opensteer({
  name: "my-scraper",
  storage: { rootDir: process.cwd() },
});
await opensteer.launch({ headless: false });
await opensteer.close();

// Or wrap an existing Playwright page:
const opensteer = Opensteer.from(existingPage, { name: "my-scraper" });
```

## Properties

```typescript
opensteer.page;    // Raw Playwright Page — only for page.evaluate(fetch), page.waitForSelector, page.waitForTimeout
opensteer.context; // Raw Playwright BrowserContext
```

## Navigation

```typescript
await opensteer.goto(url);                      // Navigate + waitForVisualStability
await opensteer.goto(url, { timeout: 60000 });  // Custom timeout
```

## Observation

```typescript
const html = await opensteer.snapshot();                          // Action mode (default)
const html = await opensteer.snapshot({ mode: "extraction" });    // Extraction mode
const state = await opensteer.state();                            // { url, title, html }
const buffer = await opensteer.screenshot();                      // PNG buffer
const jpeg = await opensteer.screenshot({ type: "jpeg", fullPage: true });
```

## Interactions

```typescript
await opensteer.click({ element: 5 });
await opensteer.click({ description: "the submit button" });
await opensteer.click({ selector: "#btn" });
await opensteer.dblclick({ element: 7 });
await opensteer.rightclick({ element: 7 });
await opensteer.hover({ element: 4 });
await opensteer.input({ element: 3, text: "Hello" });
await opensteer.input({ description: "search", text: "q", pressEnter: true });
await opensteer.select({ element: 9, label: "Option A" });
await opensteer.scroll();
await opensteer.scroll({ direction: "up", amount: 500 });
```

## Data Extraction

```typescript
// Replay from cached descriptions (preferred in scraper scripts)
const data = await opensteer.extract({
  description: "product details",
});

// Counter-based (during exploration or when no cache exists)
const data = await opensteer.extract({
  schema: { title: { element: 3 }, price: { element: 7 } },
  description: "product details",
});
```

Schema field types: `{ element: N }`, `{ element: N, attribute: "href" }`, `{ selector: ".price" }`, `{ source: "current_url" }`.

For arrays, include multiple items in the schema. Opensteer caches the structural pattern and expands to all matching items on replay.

## Keyboard

```typescript
await opensteer.pressKey("Enter");
await opensteer.pressKey("Control+a");
await opensteer.type("Hello World");
```

## Element Info

```typescript
const text = await opensteer.getElementText({ element: 5 });
const value = await opensteer.getElementValue({ element: 3 });
const attrs = await opensteer.getElementAttributes({ element: 5 });
const box = await opensteer.getElementBoundingBox({ element: 5 });
const html = await opensteer.getHtml();
const html = await opensteer.getHtml("main");
const title = await opensteer.getTitle();
```

## Wait

**Do NOT use wait calls before SDK actions** — each action handles waiting internally. Only use explicit waits for page transitions or confirming SPA content loaded.

```typescript
await opensteer.waitForText("Success");                              // Literal text on page
await opensteer.waitForText("Success", { timeout: 5000 });
await opensteer.page.waitForSelector("article");                     // CSS selector
await opensteer.page.waitForSelector(".loading", { state: "hidden" });
```

## Tabs

```typescript
const tabs = await opensteer.tabs();
await opensteer.newTab("https://example.com");
await opensteer.switchTab(0);
await opensteer.closeTab(1);
```

## Cookies

```typescript
const cookies = await opensteer.getCookies();
await opensteer.setCookie({ name: "token", value: "abc" });
await opensteer.clearCookies();
await opensteer.exportCookies("/tmp/cookies.json");
await opensteer.importCookies("/tmp/cookies.json");
```

## File Upload

```typescript
await opensteer.uploadFile({ element: 5, paths: ["/path/to/file.pdf"] });
```

## Methods That DO NOT Exist

| Wrong (throws)                   | Correct                                |
| -------------------------------- | -------------------------------------- |
| `opensteer.evaluate(...)`        | `opensteer.page.evaluate(...)`         |
| `opensteer.waitForSelector(...)` | `opensteer.page.waitForSelector(...)`  |
| `opensteer.waitForLoad(...)`     | `opensteer.page.waitForLoadState(...)` |
| `opensteer.navigate(...)`        | `opensteer.goto(...)`                  |
| `opensteer.browser_launch(...)`  | `opensteer.launch(...)`                |
| `opensteer.browser_close(...)`   | `opensteer.close(...)`                 |
