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
    // The Home's own apps and plugin pages are framed by the Home's own web app, and by nothing
    // else: an explicit list, set where they are served, and no X-Frame-Options (M3).
    for (const route of ["/v1/apps", "/v1/plugin-pages"]) {
      const path = `${route}/app_${crypto.randomUUID()}/dark/${"a".repeat(43)}/`;
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy, path).toContain(`frame-ancestors 'self' ${origin}`);
      expect(policy.match(/frame-ancestors/gu), path).toHaveLength(1);
      expect(policy, path).not.toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options"), path).toBeNull();
    }
  } finally {
    await host.close();
  }
});
