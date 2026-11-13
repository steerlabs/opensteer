import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { requestToolNames, toolsFor } from "../index.js";
import { device_access_request } from "./computer.js";

it("exposes device access only to Runs and holds it as a durable Request", () => {
  expect(toolsFor({ kind: "run", accessMode: "full-access" })).toContain(device_access_request);
  for (const kind of ["program", "connection"] as const)
    expect(toolsFor({ kind, accessMode: "full-access" })).not.toContain(device_access_request);
  expect(requestToolNames).toContain("device_access_request");
  const input = {
    machineId: createId("runner"),
    access: "files",
    reason: "Read the task's project",
  };
  expect(device_access_request.input.parse(input)).toEqual(input);
  expect(device_access_request.input.safeParse({ ...input, allowForTask: true }).success).toBe(
    false,
  );
});
