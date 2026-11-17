import { createId } from "@opensteer/core";

import { describe, expect, it } from "vitest";
import { carriesApproval } from "../local-servers/local-server-service.js";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";

/** A call with no Run behind it, as a Trigger occurrence makes. */
describe("carriesApproval", () => {
  const mac = createId("runner");
  const launch = (env: Record<string, string>, secrets: string[] = []) => ({
    args: [],
    command: "node",
    cwd: "/plugin",
    env,
    type: "stdio" as const,
    ...(secrets.length ? { secrets: secrets.map((name) => ({ name, title: name })) } : {}),
  });
  const old = launch({ EDITION: "1" }, ["CAMERA_PASSWORD", "OLD_TOKEN"]);
  const approved = { approvedLaunchDigest: localMcpLaunchDigest(old), status: "active" };
  it.each([
    ["new code, same secrets", approved, mac, launch({ EDITION: "2" }, ["CAMERA_PASSWORD"]), true],
    ["no secrets left", approved, mac, launch({ EDITION: "2" }), true],
    ["a new secret", approved, mac, launch({ EDITION: "2" }, ["CAMERA_PASSWORD", "NEW"]), false],
    ["another computer", approved, createId("runner"), launch({ EDITION: "2" }), false],
    ["declined", { ...approved, status: "disabled" }, mac, launch({ EDITION: "2" }), false],
    ["never approved", { ...approved, approvedLaunchDigest: null }, mac, launch({}), false],
    ["waiting on an older answer", { ...approved, approvedLaunchDigest: "other" }, mac, old, false],
  ])("%s", (_, existing, runnerId, next, carries) => {
    expect(
      carriesApproval(existing, { launch: old, runnerId: mac }, { launch: next, runnerId }),
    ).toBe(carries);
  });
});
