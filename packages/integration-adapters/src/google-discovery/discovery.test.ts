import { describe, expect, it, vi } from "vitest";
import { definitionClosure } from "@opensteer/integration-core/tool-schemas";
import { openApiAdapter } from "../openapi/adapter.js";
import { convertGoogleDiscoveryDocument, googleDiscoveryOpenApiConfig } from "./discovery.js";

const discovery = {
  name: "tasks",
  version: "v1",
  title: "Tasks API",
  rootUrl: "https://tasks.googleapis.com/",
  servicePath: "tasks/v1/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/tasks.readonly": {
          description: "Read tasks",
        },
      },
    },
  },
  parameters: {
    alt: { type: "string", location: "query" },
  },
  schemas: {
    Task: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string", required: true } },
    },
    Tasks: {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "Task" } },
      },
    },
  },
  resources: {
    tasks: {
      methods: {
        list: {
          id: "tasks.tasks.list",
          httpMethod: "GET",
          path: "lists/{tasklist}/tasks",
          description: "Lists tasks",
          parameters: {
            tasklist: { type: "string", location: "path", required: true },
            maxResults: { type: "integer", location: "query" },
          },
          response: { $ref: "Tasks" },
          scopes: ["https://www.googleapis.com/auth/tasks.readonly"],
        },
      },
    },
  },
};

describe("Google Discovery conversion", () => {
  it("converts methods, schemas, parameters, and OAuth scopes to OpenAPI 3", () => {
    const converted = convertGoogleDiscoveryDocument(discovery);
    expect(converted.openapi).toBe("3.1.0");
    expect(converted).toMatchObject({
      paths: {
        "/lists/{tasklist}/tasks": {
          get: {
            operationId: "tasks.tasks.list",
            security: [{ googleOAuth2: ["https://www.googleapis.com/auth/tasks.readonly"] }],
          },
        },
      },
      components: {
        schemas: {
          tasks_Task: { type: "object" },
          tasks_Tasks: { type: "object" },
        },
      },
    });
  });

  it("runs helper config -> discovery fetch -> resolve -> invoke", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/discovery/v1/apis/tasks/v1/rest")) {
        return new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toContain("/tasks/v1/lists/inbox/tasks");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer google-token");
      return new Response(JSON.stringify({ items: [{ id: "1", title: "Ship" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch_);
    const config = googleDiscoveryOpenApiConfig(["tasks:v1"]);
    const { definitions, tools } = await openApiAdapter.resolveTools({ config });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("tasks.tasksList");
    expect(tools[0]?.outputSchema).toEqual({ $ref: "#/$defs/tasks_Tasks" });
    expect(definitionClosure([tools[0]?.inputSchema, tools[0]?.outputSchema], definitions)).toEqual(
      ["tasks_Task", "tasks_Tasks"],
    );
    await expect(
      openApiAdapter.invokeTool({
        config,
        target: tools[0]?.target ?? null,
        toolName: "tasks.tasksList",
        args: { tasklist: "inbox" },
        credentialValues: { accessToken: "google-token" },
        placements: [
          {
            carrier: "header",
            name: "Authorization",
            prefix: "Bearer ",
            variable: "accessToken",
          },
        ],
      }),
    ).resolves.toMatchObject({ kind: "ok" });
  });
});
