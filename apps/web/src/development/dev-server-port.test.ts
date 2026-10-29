import { describe, expect, it } from "vitest";
import { defaultWebPort, resolveWebPort } from "./dev-server-port.js";

describe("resolveWebPort", () => {
  it("uses the dedicated Opensteer development port by default", () => {
    expect(resolveWebPort(undefined)).toBe(defaultWebPort);
    expect(resolveWebPort("")).toBe(43_100);
  });

  it("accepts an explicitly configured unprivileged TCP port", () => {
    expect(resolveWebPort("43101")).toBe(43_101);
  });

  it.each(["1023", "65536", "43100.5", "not-a-port"])("rejects %s", (value) => {
    expect(() => resolveWebPort(value)).toThrow(
      "OPENSTEER_WEB_PORT must be an integer from 1024 through 65535",
    );
  });
});
