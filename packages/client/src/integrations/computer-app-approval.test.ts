import { expect, it } from "vitest";
import {
  computerAppApprovalView,
  type ComputerAppApprovalReview,
} from "./computer-app-approval.js";

const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const request = {
  id: "00000000-0000-4000-8000-000000000001",
  runnerId: "run_1",
  kind: "app",
  access: "read",
  definitionId: "macos-app",
  app: notes,
  server: null,
  reason: null,
  threadTitle: "Plan the week",
} as unknown as ComputerAppApprovalReview["request"];
const resolved = {
  allowed: true,
  identity: notes,
  path: "/System/Applications/Notes.app",
  reason: null,
  risk: "standard",
  running: false,
} as const;

it("says what agents may do with a Mac app at each access, and warns only for an elevated one", () => {
  const read = computerAppApprovalView({ request, app: resolved, name: "Notes" });
  expect(read).toMatchObject({
    title: "Allow Notes?",
    context: "For “Plan the week”",
    app: notes,
    details: { label: "Details", text: "/System/Applications/Notes.app" },
    warning: null,
  });
  expect(read.abilities.map(({ allowed }) => allowed)).toEqual([true, false]);

  const write = computerAppApprovalView({
    request: { ...request, access: "read-write" },
    app: { ...resolved, risk: "elevated" },
  });
  expect(write.abilities.map(({ allowed }) => allowed)).toEqual([true, true]);
  expect(write.warning).not.toBeNull();
});

it("names an app from an older Host, which sends no name, by what the request knows", () => {
  expect(computerAppApprovalView({ request, app: null }).name).toBe("Notes");
  expect(
    computerAppApprovalView({
      request: { ...request, app: null, definitionId: "iphone-location" },
      app: null,
    }).name,
  ).toBe("iphone-location");
});

it("shows how a server runs and names its computer, never its secrets' declaration", () => {
  const view = computerAppApprovalView(
    {
      request: {
        ...request,
        kind: "server",
        app: null,
        threadTitle: null,
        access: "read-write",
        server: {
          name: "camera",
          installationTitle: "Tapo",
          launch: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            cwd: "/plugin",
            env: { REGION: "eu" },
            secrets: [{ name: "CAMERA_PASSWORD", title: "Camera password" }],
          },
        },
      } as unknown as ComputerAppApprovalReview["request"],
      app: null,
    },
    "Studio",
  );
  expect(view).toMatchObject({ title: "Allow Tapo?", context: "On Studio" });
  expect(view.abilities[0]?.text).toBe("Runs on Studio as you");
  expect(view.details?.text).toBe("node server.js\nin /plugin\nREGION=eu");
  expect(view.details?.text).not.toContain("CAMERA_PASSWORD");
});
