import { describe, expect, it, vi } from "vitest";
import { boundPageRestore, WakeSeeds } from "./page-restore.js";
import type { IpcMain, IpcMainEvent, WebContents } from "electron";

describe("page restore", () => {
  it("drops distant page state first and refuses oversized storage or irreducible history", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      url: `https://site.test/${i}`,
      title: "",
      pageState: "x".repeat(300_000),
    }));
    const result = boundPageRestore({ entries, index: 2, sessionStorage: null })!;
    expect(result.entries.map((entry) => !!entry.pageState)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 ** 2);
    expect(
      boundPageRestore({
        entries,
        index: 2,
        sessionStorage: { origin: "https://site.test", items: [["key", "x".repeat(256 * 1024)]] },
      }),
    ).toBeNull();
    expect(
      boundPageRestore({
        entries: [{ url: "x".repeat(1024 ** 2), title: "" }],
        index: 0,
        sessionStorage: null,
      }),
    ).toBeNull();
  });
  it("answers once to the waking page's own main frame at the saved origin", () => {
    const ipc = { on: vi.fn(), off: vi.fn() };
    const seeds = new WakeSeeds(ipc as unknown as IpcMain);
    const mainFrame = { url: "https://site.test/form" };
    const contents = { id: 17, mainFrame, once: vi.fn() };
    const answer = ipc.on.mock.calls[0]![1] as (event: IpcMainEvent) => void;
    const ask = (senderFrame: object, sender = contents) => {
      const event = { sender, senderFrame, returnValue: undefined };
      answer(event as unknown as IpcMainEvent);
      return event.returnValue;
    };
    const offer = () =>
      seeds.offer(contents as unknown as WebContents, {
        origin: "https://site.test",
        items: [["token", "secret"]],
      });
    offer();
    expect(ask(mainFrame, { ...contents, id: 18 })).toBeNull();
    expect(ask(mainFrame)).toEqual([["token", "secret"]]);
    expect(ask(mainFrame)).toBeNull();
    offer();
    expect(ask({ url: mainFrame.url })).toBeNull();
    expect(ask(mainFrame)).toBeNull();
    offer();
    mainFrame.url = "https://other.test/";
    expect(ask(mainFrame)).toBeNull();
    offer();
    mainFrame.url = "https://site.test/";
    contents.once.mock.calls.at(-1)![1]();
    expect(ask(mainFrame)).toBeNull();
    seeds.close();
    expect(ipc.off).toHaveBeenCalled();
  });
});
