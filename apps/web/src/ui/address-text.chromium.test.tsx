import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { addressParts } from "@opensteer/client/host";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Address } from "./address-text.js";

/**
 * Where a real browser breaks an address's lines, read from the rendered text
 * (`Range.getClientRects()`), at 390 wide: every line ends at one of the address's joints,
 * except inside a part that alone is wider than the line; nothing is added (no hyphen), and
 * selecting and copying gives the address exactly.
 */
const addresses = [
  "tim@münchen.de",
  "foo.xn--p1ai",
  "Studio.Local",
  "my-host.opensteer.example",
  "https://claude.ai/api/mcp/auth_callback?state=abc123&scope=read#top",
  "averyveryverylongsubdomainwithnojointsatallwiderthantheline.example",
];

let browserServer: BrowserServer | undefined;
let browser: Browser | undefined;
let page: Page;
beforeAll(async () => {
  browserServer = await chromium.launchServer({ timeout: 5_000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
  page = await browser.newPage({ viewport: { width: 390, height: 2000 } });
  const css = await readFile(new URL("../styles/address.css", import.meta.url), "utf8");
  const rows = addresses
    .map(
      (value, index) =>
        `<p id="row-${index}" style="margin:0 0 24px;width:358px;font:26px/1.3 sans-serif">Send it to ${renderToStaticMarkup(<Address value={value} />)} now.</p>`,
    )
    .join("");
  await page.setContent(
    `<!doctype html><style>${css}</style><body style="margin:16px">${rows}</body>`,
  );
});
afterAll(async () => {
  await browser?.close();
  if (browserServer)
    await withTimeout(browserServer.kill(), 5_000, {
      timeoutError: () => new Error("Owned Chromium did not exit"),
    });
});

/** The address's characters grouped by the rendered line each one sits on. */
async function renderedLines(index: number): Promise<string[]> {
  return page.evaluate((row) => {
    const address = document.querySelector(`#row-${row} .address`)!;
    const lines: { top: number; text: string }[] = [];
    const walker = document.createTreeWalker(address, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let offset = 0; offset < text.length; offset += 1) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const top = Math.round(range.getClientRects()[0]!.top);
        const line = lines.at(-1);
        if (line && Math.abs(line.top - top) < 4) line.text += text[offset];
        else lines.push({ top, text: text[offset]! });
      }
    }
    return lines.map(({ text }) => text);
  }, index);
}

it.each(addresses.map((value, index) => [value, index] as const))(
  "breaks %s only at its joints, adds nothing, and copies exactly",
  async (value, index) => {
    const lines = await renderedLines(index);
    expect(lines.join("")).toBe(value);
    expect(lines.join("")).not.toMatch(/[­‐‑]/u);
    const parts = addressParts(value);
    const joints = new Set(parts.map((_, i) => parts.slice(0, i + 1).join("").length));
    // A part that alone is wider than the line is the only one that may break inside itself:
    // measured, each part laid out on its own without wrapping, against the line's width.
    const widths = await page.evaluate((row) => {
      const element = document.querySelector<HTMLElement>(`#row-${row}`)!;
      return [...element.querySelectorAll<HTMLElement>(".address__part")].map((part) => {
        const alone = part.cloneNode(true) as HTMLElement;
        Object.assign(alone.style, {
          maxWidth: "none",
          whiteSpace: "nowrap",
          position: "absolute",
        });
        element.append(alone);
        const wider = alone.getBoundingClientRect().width > element.clientWidth;
        alone.remove();
        return wider;
      });
    }, index);
    const wide = parts.filter((_, i) => widths[i]);
    let offset = 0;
    for (const line of lines.slice(0, -1)) {
      offset += line.length;
      const inside = parts.find((_, i) => {
        const start = parts.slice(0, i).join("").length;
        return offset > start && offset < start + parts[i]!.length;
      });
      expect(joints.has(offset) || (inside !== undefined && wide.includes(inside)), line).toBe(
        true,
      );
    }
    const copied = await page.evaluate((row) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(`#row-${row} .address`)!);
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }, index);
    expect(copied).toBe(value);
  },
);

it("wraps the long URL and the wide host over more than one line, so the joints are tested", async () => {
  expect((await renderedLines(4)).length).toBeGreaterThan(1);
  expect((await renderedLines(5)).length).toBeGreaterThan(1);
});
