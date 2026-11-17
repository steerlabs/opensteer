import { describe, expect, it, vi } from "vitest";
import { createSettingsRead, redirectSettingsPath, settingsRedirects } from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("Settings models", () => {
  it("coalesces bursts and fences reconnect and disposed attachments", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const fail = vi.fn();
    const page = createSettingsRead<number>(read, publish, fail);
    const done = page.refresh();
    for (let i = 0; i < 50; i++) void page.refresh();
    void page.reconnect();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 1000 });
    expect(publish).not.toHaveBeenCalled();
    page.dispose();
    second.resolve(2);
    await done;
    expect(publish).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
  it("retains the last readable value after failure and can reread", async () => {
    const publish = vi.fn();
    const fail = vi.fn();
    const page = createSettingsRead(
      vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(2),
      publish,
      fail,
    );
    await page.refresh();
    await page.refresh();
    expect(publish.mock.calls).toEqual([[1]]);
    expect(fail).toHaveBeenCalledOnce();
    await page.reconnect();
    expect(publish.mock.calls).toEqual([[1], [2]]);
  });
  it.each(settingsRedirects)("redirects %s with raw callback selectors", (from, to) => {
    const tail = "?integrationAttempt=a%2Bb&provider=google&workspace=w#computer-app-mail";
    expect(redirectSettingsPath(`${from}${tail}`)).toBe(`${to}${tail}`);
    expect(redirectSettingsPath(`${from}/child${tail}`)).toBe(
      `${to}${to === "/settings/plugins" || to === "/settings/account" ? "" : "/child"}${tail}`,
    );
    expect(redirectSettingsPath(`${from}-other`)).toBe(
      from.startsWith("/settings/apps/") ? "/settings/plugins" : null,
    );
  });
});
