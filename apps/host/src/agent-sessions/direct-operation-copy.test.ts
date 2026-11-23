import { describe, expect, it } from "vitest";
import { directOperationCopy } from "./agent-session-service.js";

describe("directOperationCopy", () => {
  it("quotes and bidi-isolates the agent name in titles and summaries", () => {
    const rtlAgent = "\u0639\u0645\u064A\u0644 2";
    const copy = directOperationCopy(
      "computer_use",
      {
        grant: {
          kind: "computer-app",
          approvalId: "editor-approval",
          deviceId: "dev_00000000-0000-4000-8000-000000000001" as never,
          app: {
            kind: "mac-app",
            bundleId: "com.example.editor",
            teamId: null,
          },
        },
        name: "Editor",
        device: {
          id: "dev_00000000-0000-4000-8000-000000000001" as never,
          name: "Studio Mac",
        },
      },
      rtlAgent,
    );
    expect(copy.title).toBe(`Let “\u2068${rtlAgent}\u2069” use Editor on Studio Mac?`);
    expect(copy.summary).toBe(
      `Editor · Studio Mac\n“\u2068${rtlAgent}\u2069” wants to use Editor on Studio Mac.`,
    );
  });

  it("neutralizes double quotes inside an agent name so it cannot close Opensteer's quotation", () => {
    const copy = directOperationCopy(
      "plugin_call",
      {
        grant: { kind: "plugin", target: { kind: "installed", pluginId: "plg_test" } },
        name: "Calendar",
        device: null,
      },
      "Opensteer” approved “all",
    );
    expect(copy.title).toBe("Let “\u2068Opensteer’ approved ‘all\u2069” change Calendar?");
    expect(copy.summary).toBe("“\u2068Opensteer’ approved ‘all\u2069” wants to change Calendar.");
  });
});
