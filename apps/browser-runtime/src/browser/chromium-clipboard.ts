/// <reference lib="dom" />
import type { Browser, BrowserContext, Page } from "playwright-core";
import { z } from "zod";
import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import type {
  BrowserPage,
  EngineClipboard,
  EngineClipboardItem,
  EngineClipboardScope,
} from "@opensteer/browser-runtime-core";
import { editingClipboardMaxBytes, editingClipboardMaxItems } from "@opensteer/protocol/editing";

const representations = z
  .array(z.object({ type: z.string(), data: z.string() }))
  .max(editingClipboardMaxItems);
const fingerprints = z
  .array(z.object({ type: z.string(), size: z.number(), digest: z.string() }))
  .max(editingClipboardMaxItems);

/** Headless Chromium's process-local clipboard, reached from a non-session context. */
export class ChromiumClipboard implements EngineClipboard {
  readonly machineClipboardShared = false;
  readonly #context: BrowserContext;
  readonly #page: Page;
  #open = false;

  private constructor(context: BrowserContext, page: Page) {
    this.#context = context;
    this.#page = page;
  }

  static async create(browser: Browser): Promise<ChromiumClipboard> {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    try {
      await context.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Private clipboard</title>",
        }),
      );
      const page = await context.newPage();
      await page.goto("http://opensteer-clipboard.localhost/");
      const clipboard = new ChromiumClipboard(context, page);
      await clipboard.#write([]);
      return clipboard;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async open(
    _page: BrowserPage,
    input: readonly EngineClipboardItem[] | null,
  ): Promise<EngineClipboardScope> {
    if (this.#open) throw new Error("The browser clipboard scope is already open.");
    this.#open = true;
    try {
      await this.#write(input ?? []);
      // A fingerprint tells whether the page wrote during the scope without
      // carrying the clipboard's bytes back; only a write is read in full.
      const initial = JSON.stringify(await this.#fingerprint());
      let closed: Promise<readonly EngineClipboardItem[] | null> | null = null;
      return {
        close: () => {
          closed ??= (async () => {
            try {
              if (JSON.stringify(await this.#fingerprint()) === initial) return null;
              const result = await this.#read();
              return result.map((item) => ({
                type: item.type,
                bytes: Buffer.from(item.data, "base64"),
              }));
            } finally {
              try {
                await this.#write([]);
              } finally {
                this.#open = false;
              }
            }
          })();
          return closed;
        },
      };
    } catch (error) {
      try {
        await this.#write([]);
      } finally {
        this.#open = false;
      }
      throw error;
    }
  }

  async #write(items: readonly EngineClipboardItem[]): Promise<void> {
    if (
      items.length > editingClipboardMaxItems ||
      items.reduce((sum, item) => sum + item.bytes.length, 0) > editingClipboardMaxBytes
    )
      throw new Error("Clipboard data exceeds its bound.");
    if (new Set(items.map((item) => item.type)).size !== items.length)
      throw new Error("Duplicate clipboard representations are not supported.");
    await this.#page.evaluate(
      async (data) => {
        if (!data.length) {
          await navigator.clipboard.writeText("");
          return;
        }
        const parts: Record<string, Blob> = {};
        for (const item of data) {
          const decoded = await fetch(`data:${item.type};base64,${item.data}`);
          parts[item.type] = new Blob([await decoded.arrayBuffer()], { type: item.type });
        }
        await navigator.clipboard.write([new ClipboardItem(parts)]);
      },
      items.map((item) => ({ type: item.type, data: Buffer.from(item.bytes).toString("base64") })),
    );
  }

  async #fingerprint(): Promise<z.infer<typeof fingerprints>> {
    const fingerprint = await this.#page.evaluate(
      async ({ maximum, items }) => {
        const result: { type: string; size: number; digest: string }[] = [];
        let total = 0;
        for (const item of await navigator.clipboard.read()) {
          for (const type of item.types) {
            const blob = await item.getType(type);
            total += blob.size;
            if (total > maximum || result.length >= items) return null;
            const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
            result.push({
              type,
              size: blob.size,
              digest: Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            });
          }
        }
        return result;
      },
      { maximum: editingClipboardMaxBytes, items: editingClipboardMaxItems },
    );
    if (fingerprint === null)
      throw new BrowserRuntimeError("bad_message", "Clipboard data exceeds its bound.", {
        reason: "clipboard-too-large",
      });
    return fingerprints.parse(fingerprint);
  }

  async #read(): Promise<z.infer<typeof representations>> {
    const data = await this.#page.evaluate(async (maximum) => {
      const result: { type: string; data: string }[] = [];
      let total = 0;
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          total += blob.size;
          if (total > maximum || result.length >= 16) return null;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let at = 0; at < bytes.length; at += 8192)
            binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
          result.push({ type, data: btoa(binary) });
        }
      }
      return result;
    }, editingClipboardMaxBytes);
    if (data === null)
      throw new BrowserRuntimeError("bad_message", "Clipboard data exceeds its bound.", {
        reason: "clipboard-too-large",
      });
    return representations.parse(data);
  }

  close(): Promise<void> {
    return this.#context.close();
  }
}
