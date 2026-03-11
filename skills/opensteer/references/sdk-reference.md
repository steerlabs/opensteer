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

// Use the user's local Chrome profile state:
const opensteer = new Opensteer({
  name: "my-scraper",
  browser: {
    mode: "real",
    profileDirectory: "Default",
    headless: false,
  },
});
await opensteer.launch();

// Or pass real-browser mode at launch time:
await opensteer.launch({
  mode: "real",
  profileDirectory: "Default",
  headless: false,
});

// Wrap an existing page instance:
const opensteer = Opensteer.from(existingPage, { name: "my-scraper" });
```

## Properties

```typescript
opensteer.page;    // Low-level page handle (see "Advanced: Direct Page Access" in SKILL.md)
opensteer.context; // Low-level browser context handle
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

// Semantic extraction: schema is the output shape
const images = await opensteer.extract({
  description: "article images with captions and credits",
  prompt: "For each image, return the image URL, alt text, caption, and credit. Prefer caption and credit from the same figure. If missing, look at sibling text, then parent/container text, then nearby alt/data-* attributes.",
  schema: {
    images: [{ imageUrl: "string", alt: "string", caption: "string", credit: "string" }],
  },
});

// Explicit bindings (during exploration or when no cache exists)
const data = await opensteer.extract({
  schema: { title: { element: 3 }, price: { element: 7 } },
  description: "product details",
});
```

`schema` describes the output shape, not just selector config. It can use semantic placeholders like `"string"` and arrays of objects, or explicit field bindings such as `{ element: N }`, `{ element: N, attribute: "href" }`, `{ selector: ".price" }`, and `{ source: "current_url" }`.

Use `prompt` to describe relationship/fallback rules, such as matching each image to its caption and credit.

For explicit array bindings, include multiple items in the schema so Opensteer can infer the repeating pattern. For semantic extraction, a single representative object shape is enough.

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
// For CSS selector waits, see "Advanced: Direct Page Access" in SKILL.md
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

## Common Mistakes

| If you want to...        | Use this                          |
| ------------------------ | --------------------------------- |
| Navigate to a URL        | `opensteer.goto(url)`             |
| Launch the browser       | `opensteer.launch()`              |
| Close the browser        | `opensteer.close()`               |
| Get page text content    | `opensteer.getElementText()`      |
| Get page HTML            | `opensteer.getHtml()`             |
| Extract structured data  | `opensteer.extract()`             |
| Wait for content         | `opensteer.waitForText()`         |

> **SDK Rule**: Every browser action in a script MUST use an `opensteer.*` method.
