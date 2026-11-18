import { expect, it } from "vitest";
import { presentPluginToolResult, projectDirectPluginTools } from "./local-tool-results.js";

it("reports a refused batch call as failed and retains its attachment", () => {
  const failedPath = 'tools["local-server"].write';
  const successPath = 'tools["local-server"].read';
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const result = projectDirectPluginTools({
    execution: {
      ok: true,
      value: [
        {
          path: failedPath,
          ok: true,
          value: {
            kind: "mcp",
            result: { isError: true, content: [image], structuredContent: { reason: "Refused" } },
          },
        },
        { path: successPath, ok: true, value: { kind: "value", value: { rows: 2 } } },
      ],
    },
  });
  const response = presentPluginToolResult({ result });
  expect(response.structuredContent).toMatchObject({
    result: {
      execution: {
        ok: true,
        value: [
          { path: failedPath, ok: false, value: { reason: "Refused" } },
          { path: successPath, ok: true, value: { rows: 2 } },
        ],
      },
    },
  });
  expect(response.content).toEqual([
    { type: "text", text: JSON.stringify(response.structuredContent) },
    image,
  ]);
});

it("keeps a cloud plugin's blocked-shaped data as a regular result", () => {
  const path = "tools.fixture.read";
  const value = {
    kind: "blocked",
    blocked: { code: "unavailable", message: "Plugin data", next: "Plugin data" },
  };
  const result = projectDirectPluginTools({
    execution: {
      ok: true,
      value: { path, ok: true, value: { kind: "value", value } },
    },
  });
  const response = presentPluginToolResult({ result });
  expect(response.structuredContent).toMatchObject({
    result: { execution: { ok: true, value: { path, ok: true, value } } },
  });
  expect(response.isError).not.toBe(true);
});
