import { expect, it } from "vitest";
import { presentPluginToolResult, projectDirectLocalTools } from "./local-tool-results.js";

it("reports a refused batch call as failed and retains its attachment", () => {
  const failedPath = 'tools["local-server"].write';
  const successPath = 'tools["local-server"].read';
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const result = projectDirectLocalTools({
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
