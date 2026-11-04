import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DesktopLoginSession } from "./login-session.js";

const session = (input: { consoleOwner?: () => number; platform?: NodeJS.Platform } = {}) => {
  const power = new EventEmitter();
  return {
    power,
    session: new DesktopLoginSession(power, input.platform ?? "darwin", {
      consoleOwner: input.consoleOwner ?? (() => 501),
      user: 501,
    }),
  };
};

describe("DesktopLoginSession", () => {
  it("reads the console's owner instead of assuming the session is active", () => {
    let owner = 502;
    const { session: login } = session({ consoleOwner: () => owner });
    expect(login.active()).toBe(false);
    owner = 501;
    expect(login.active()).toBe(true);
  });

  it("treats an unreadable console as inactive", () => {
    const { session: login } = session({
      consoleOwner: () => {
        throw new Error("EACCES");
      },
    });
    expect(login.active()).toBe(false);
  });

  it.each(["linux", "win32"] as const)("never claims the session on %s", (platform) => {
    expect(session({ platform }).session.active()).toBe(false);
  });

  it("reports the system's session changes until disposed", () => {
    const { power, session: login } = session();
    const changed = vi.fn();
    login.subscribe(changed);
    power.emit("user-did-resign-active");
    power.emit("user-did-become-active");
    expect(changed.mock.calls).toEqual([[false], [true]]);
    login.dispose();
    power.emit("user-did-resign-active");
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
