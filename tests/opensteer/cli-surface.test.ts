import type { OpensteerSemanticRuntime } from "@opensteer/runtime-core";

import { describe, expect, test } from "vitest";

import { buildOperationInput } from "../../packages/opensteer/src/cli/operation-input.js";
import { renderOperationOutput } from "../../packages/opensteer/src/cli/output.js";
import { parseCommandLine } from "../../packages/opensteer/src/cli/parse.js";

const DUMMY_RUNTIME = {} as OpensteerSemanticRuntime;

describe("CLI surface parsing", () => {
  test("reads OPENSTEER_WORKSPACE as the workspace fallback", () => {
    const previousWorkspace = process.env.OPENSTEER_WORKSPACE;
    process.env.OPENSTEER_WORKSPACE = "workspace-from-env";

    try {
      const parsed = parseCommandLine(["network", "query"]);
      expect(parsed.options.workspace).toBe("workspace-from-env");
    } finally {
      if (previousWorkspace === undefined) {
        delete process.env.OPENSTEER_WORKSPACE;
      } else {
        process.env.OPENSTEER_WORKSPACE = previousWorkspace;
      }
    }
  });

  test("builds click input from positional element args", async () => {
    const parsed = parseCommandLine([
      "click",
      "7",
      "--persist",
      "search button",
      "--capture-network",
      "search",
    ]);

    await expect(buildOperationInput("dom.click", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      target: {
        kind: "element",
        element: 7,
      },
      persist: "search button",
      captureNetwork: "search",
    });
  });

  test("builds input text from positional args", async () => {
    const parsed = parseCommandLine(["input", "5", "laptop pro", "--press-enter"]);

    await expect(buildOperationInput("dom.input", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      target: {
        kind: "element",
        element: 5,
      },
      text: "laptop pro",
      pressEnter: true,
    });
  });

  test("defaults scroll to the page root when no element is provided", async () => {
    const parsed = parseCommandLine(["scroll", "down", "250", "--capture-network", "feed"]);

    await expect(buildOperationInput("dom.scroll", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      target: {
        kind: "selector",
        selector: "html",
      },
      direction: "down",
      amount: 250,
      captureNetwork: "feed",
    });
  });

  test("builds fetch input with scoped JSON flags", async () => {
    const parsed = parseCommandLine([
      "fetch",
      "https://example.com/api/search",
      "--method",
      "POST",
      "--body-json",
      "{\"keyword\":\"laptop\"}",
      "--header",
      "accept=application/json",
      "--cookies",
      "false",
      "--follow-redirects",
    ]);

    await expect(buildOperationInput("session.fetch", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      url: "https://example.com/api/search",
      method: "POST",
      headers: {
        accept: "application/json",
      },
      body: {
        json: {
          keyword: "laptop",
        },
      },
      cookies: false,
      followRedirects: true,
    });
  });

  test("treats run as an unknown command", () => {
    const parsed = parseCommandLine(["run", "network.query"]);
    expect(parsed.command).toEqual(["run"]);
  });

  test("labels network query json mode as a response filter in output", () => {
    const output = renderOperationOutput(
      "network.query",
      {
        records: [
          {
            recordId: "record:1",
            capture: "search",
            method: "GET",
            status: 200,
            resourceType: "fetch",
            url: "https://example.com/api/search",
            response: {
              bytes: 1234,
              contentType: "application/json",
            },
          },
        ],
      },
      {
        json: true,
      },
    );

    expect(output).toContain('[network.query] 1 record from capture "search" (JSON/GraphQL only)');
  });
});
