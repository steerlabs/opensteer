import { expect, it } from "vitest";
import { requestResult } from "./request-result.js";

it.each(["integration_request", "app_access_request"])(
  "projects all %s request outcomes into one envelope",
  (tool) => {
    for (const status of ["pending", "fulfilled", "declined", "withdrawn", "cancelled"]) {
      const result = requestResult(tool, { requestId: "req_example", status, replayed: true });
      expect(result).toMatchObject({
        requestId: "req_example",
        status,
        replayed: true,
        kind: tool === "integration_request" ? "integration.access" : "computer.app.access",
        next: expect.any(String),
      });
      expect(result).not.toHaveProperty("guidance");
      if (status === "pending")
        expect(result.next).toContain("Nothing is granted until they answer");
    }
    expect(requestResult(tool, { status: "already-available" })).toMatchObject({
      status: "fulfilled",
      requestId: null,
      next: expect.stringContaining("usable now"),
    });
  },
);
