import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it } from "vitest";
import { startPrivateMachineHost } from "../runtime/private-machine-host.test-support.js";

it("frames no response of a real Home: its pages, its API, its errors (D2)", async () => {
  const database = await cloneTestDatabase("host");
  const host = await startPrivateMachineHost(database.url, { logger: false });
  try {
    const origin = `http://127.0.0.1:${host.hostPort}`;
    for (const [path, init] of [
      ["/", undefined],
      ["/tasks", undefined],
      ["/v1/descriptor", undefined],
      ["/v1/rpc/personal.shell.get", { method: "POST", body: "{}" }],
      ["/v1/no-such-route", undefined],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
        redirect: "manual",
      });
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("content-security-policy"), path).toContain(
        "frame-ancestors 'none'",
      );
    }
  } finally {
    await host.close();
  }
});
