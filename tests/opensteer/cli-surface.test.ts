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
    const parsed = parseCommandLine([
      "input",
      "5",
      "laptop pro",
      "--persist",
      "search input",
      "--press-enter",
    ]);

    await expect(buildOperationInput("dom.input", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      target: {
        kind: "element",
        element: 5,
      },
      persist: "search input",
      text: "laptop pro",
      pressEnter: true,
    });
  });

  test("defaults scroll to the page root when no element is provided", async () => {
    const parsed = parseCommandLine([
      "scroll",
      "down",
      "250",
      "--persist",
      "page root scroll",
      "--capture-network",
      "feed",
    ]);

    await expect(buildOperationInput("dom.scroll", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      target: {
        kind: "selector",
        selector: "html",
      },
      direction: "down",
      amount: 250,
      persist: "page root scroll",
      captureNetwork: "feed",
    });
  });

  test("builds extract input from positional template and required persist", async () => {
    const parsed = parseCommandLine(["extract", '{"title":3}', "--persist", "page summary"]);

    await expect(buildOperationInput("dom.extract", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      persist: "page summary",
      template: {
        title: 3,
      },
    });
  });

  test("requires persist keys for CLI DOM actions and extract", async () => {
    await expect(
      buildOperationInput("dom.click", parseCommandLine(["click", "7"]), DUMMY_RUNTIME),
    ).rejects.toThrow('click requires "--persist <key>".');

    await expect(
      buildOperationInput("dom.scroll", parseCommandLine(["scroll", "down", "250"]), DUMMY_RUNTIME),
    ).rejects.toThrow('scroll requires "--persist <key>".');

    await expect(
      buildOperationInput(
        "dom.extract",
        parseCommandLine(["extract", '{"title":3}']),
        DUMMY_RUNTIME,
      ),
    ).rejects.toThrow('extract requires "--persist <key>".');
  });

  test("builds fetch input with scoped JSON flags", async () => {
    const parsed = parseCommandLine([
      "fetch",
      "https://example.com/api/search",
      "--method",
      "POST",
      "--body",
      '{"keyword":"laptop"}',
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

  test("accepts context transport on fetch", async () => {
    const parsed = parseCommandLine([
      "fetch",
      "https://example.com/api/search",
      "--transport",
      "context",
    ]);

    await expect(buildOperationInput("session.fetch", parsed, DUMMY_RUNTIME)).resolves.toEqual({
      url: "https://example.com/api/search",
      transport: "context",
    });
  });

  test("reads open context from --context", () => {
    const parsed = parseCommandLine([
      "open",
      "https://example.com",
      "--context",
      '{"locale":"en-US"}',
    ]);

    expect(parsed.options.context).toEqual({
      locale: "en-US",
    });
  });

  test("treats run as an unknown command", () => {
    const parsed = parseCommandLine(["run", "network.query"]);
    expect(parsed.command).toEqual(["run"]);
  });

  test("parses local-view preference flags", () => {
    expect(parseCommandLine(["view", "--auto"]).options.localViewMode).toBe("auto");
    expect(parseCommandLine(["view", "--no-auto"]).options.localViewMode).toBe("manual");
  });

  test("rejects conflicting local-view preference flags", () => {
    expect(() => parseCommandLine(["view", "--auto", "--no-auto"])).toThrow(/cannot be combined/i);
  });

  test("rejects local-view preference flags on non-view commands", () => {
    expect(() => parseCommandLine(["open", "https://example.com", "--auto"])).toThrow(
      /only supported with "view"/i,
    );
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

  test("surfaces action persist keys through the resolved target", () => {
    const output = renderOperationOutput(
      "dom.click",
      {
        target: {
          tagName: "BUTTON",
          pathHint: "button#search",
          persist: "search button",
        },
      },
      undefined,
    );

    expect(output).toContain('"persist": "search button"');
    expect(output).not.toContain('"persisted"');
  });
});
