import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { requestToolNames, toolsFor } from "../index.js";
import { app_access_request, computer_access_request } from "./computer.js";

it("offers local access requests to Runs and Trigger occurrences", () => {
  const accessMode = "full-access";
  expect(toolsFor({ kind: "run", accessMode })).toContain(app_access_request);
  expect(toolsFor({ kind: "program", program: { kind: "trigger" }, accessMode })).toContain(
    app_access_request,
  );
  expect(toolsFor({ kind: "program", program: { kind: "watch" }, accessMode })).not.toContain(
    app_access_request,
  );
  expect(toolsFor({ kind: "connection", accessMode })).not.toContain(app_access_request);
});

it("exposes computer access only to Runs and holds it as a durable Request", () => {
  expect(toolsFor({ kind: "run", accessMode: "full-access" })).toContain(computer_access_request);
  for (const kind of ["program", "connection"] as const)
    expect(toolsFor({ kind, accessMode: "full-access" })).not.toContain(computer_access_request);
  expect(requestToolNames).toContain("computer_access_request");
  const input = {
    computerId: createId("runner"),
    access: "full_disk_access",
    reason: "Read the task's project",
  };
  expect(computer_access_request.input.parse(input)).toEqual(input);
  expect(computer_access_request.input.safeParse({ ...input, allowForTask: true }).success).toBe(
    false,
  );
});
