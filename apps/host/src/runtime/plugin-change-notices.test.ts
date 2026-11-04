import type { UserId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { createPluginChangeNotices } from "./plugin-change-notices.js";

const viewer = "usr_1" as UserId;

describe("plugin change notices", () => {
  it("lets shutdown wait for a lookup already started, and starts none after", async () => {
    let answer!: (viewers: readonly UserId[]) => void;
    const lookup = vi.fn(
      () =>
        new Promise<readonly UserId[]>((resolve) => {
          answer = resolve;
        }),
    );
    const send = vi.fn();
    const notices = createPluginChangeNotices(lookup, send);
    notices.notify({ runnerId: "run_1" });
    let closed = false;
    const closing = notices.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    notices.notify({ runnerId: "run_2" });
    answer([viewer]);
    await closing;
    expect(send).toHaveBeenCalledWith([viewer]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("never throws into the change that caused it when the lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn();
    const notices = createPluginChangeNotices(() => Promise.reject(new Error("offline")), send);
    expect(() => notices.notify({ requestId: "req_1" })).not.toThrow();
    await notices.close();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Plugin change notice failed", expect.any(Error));
    warn.mockRestore();
  });
});
