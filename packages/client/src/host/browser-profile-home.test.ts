import { describe, expect, it } from "vitest";
import { createId, RequestSchema } from "@opensteer/core";
import { browserAccessResponse, browserProfileHomeCommand } from "./browser-access.js";
import { MockHostClient, mockPasswordSignInRequest } from "../mock/mock-host-client.js";

describe("home-aware profile commands", () => {
  it.each(
    [0, 1, 2].flatMap((count) => ["absent", "null", "id"].map((presence) => ({ count, presence }))),
  )("mock approves with $count homes and $presence", async ({ count, presence }) => {
    const request = RequestSchema.parse({
      ...mockPasswordSignInRequest(),
      kind: "browser.access",
      originatingThreadId: createId("thread"),
      payload: {
        kind: "browser.access",
        reason: "Separate work identity",
        suggestion: { kind: "new", suggestedName: "Approved" },
      },
      presentation: {
        kind: "external",
        subject: { kind: "browser-profile-grant", id: "profile" },
        title: "Choose a profile",
      },
    });
    const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
    try {
      const snapshot = client.getSnapshot();
      const homes = snapshot
        .browserProfileHomes!.filter((id) =>
          snapshot.machines.some(
            (machine) => machine.id === id && machine.ownership !== "deployment",
          ),
        )
        .slice(0, count);
      client.setBrowserProfileHomes(homes);
      const response = {
        kind: "external" as const,
        value: {
          decision: "fulfilled",
          createProfile: {
            name: "Approved",
            ...(presence === "absent"
              ? {}
              : { homeRunnerId: presence === "null" ? null : (homes[0] ?? createId("runner")) }),
          },
        },
      };
      const result = await client.rpc["commands.dispatch"]({
        type: "request.respond",
        requestId: request.id,
        idempotencyKey: "approve",
        response,
      });
      if (count === 0 || (count === 2 && presence === "null")) {
        expect(result).toMatchObject({
          ok: false,
          error:
            count === 0 && presence === "id"
              ? { code: "forbidden" }
              : {
                  reason:
                    count === 0 ? "browser-placement-unavailable" : "browser-placement-ambiguous",
                },
        });
        expect(client.getSnapshot().requests[request.originatingThreadId]).toContainEqual(
          expect.objectContaining({ id: request.id, status: "pending" }),
        );
      } else {
        expect(result.ok).toBe(true);
        expect(client.getSnapshot().browserProfiles).toContainEqual(
          expect.objectContaining({
            name: "Approved",
            homeRunnerId: presence === "id" || count === 1 ? homes[0] : null,
          }),
        );
      }
    } finally {
      client.dispose();
    }
  });
  it.each([undefined, [], ["one"], ["one", "two"]])(
    "marks both commands only when homes are advertised: %j",
    (homes) => {
      for (const selected of [undefined, null, createId("runner")]) {
        const selection = selected === undefined ? {} : { homeRunnerId: selected };
        const create = browserProfileHomeCommand(
          {
            type: "browser.profile.create",
            idempotencyKey: "create",
            input: { name: "Work", ...selection },
          },
          homes,
        );
        const approve = browserProfileHomeCommand(
          {
            type: "request.respond",
            idempotencyKey: "approve",
            requestId: createId("request"),
            response: {
              kind: "external",
              value: { decision: "fulfilled", createProfile: { name: "Work", ...selection } },
            },
          },
          homes,
        );
        const expected =
          homes === undefined ? { name: "Work" } : { name: "Work", homeRunnerId: selected ?? null };
        expect(create.type === "browser.profile.create" && create.input).toEqual(expected);
        expect(
          approve.type === "request.respond" &&
            approve.response.kind === "external" &&
            approve.response.value?.["createProfile"],
        ).toEqual(expected);
      }
      expect(browserAccessResponse({ kind: "new" }, " Work ")).toMatchObject({
        value: { createProfile: { name: "Work", homeRunnerId: null } },
      });
    },
  );

  it.each([0, 1, 2])("mock distinguishes absent, null and id with %i homes", async (count) => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      const homes = snapshot
        .browserProfileHomes!.filter((id) =>
          snapshot.machines.some(
            (machine) => machine.id === id && machine.ownership !== "deployment",
          ),
        )
        .slice(0, count);
      client.setBrowserProfileHomes(homes);
      for (const presence of ["absent", "null", "id"]) {
        const input = {
          name: presence,
          ...(presence === "absent"
            ? {}
            : { homeRunnerId: presence === "null" ? null : (homes[0] ?? createId("runner")) }),
        };
        const result = client.rpc["commands.dispatch"]({
          type: "browser.profile.create",
          idempotencyKey: presence,
          input,
        });
        if (count === 0 || (count === 2 && presence === "null"))
          expect(await result).toMatchObject({
            ok: false,
            error:
              count === 0 && presence === "id"
                ? { code: "forbidden" }
                : {
                    reason:
                      count === 0 ? "browser-placement-unavailable" : "browser-placement-ambiguous",
                  },
          });
        else
          expect(await result).toMatchObject({
            ok: true,
            data: { profile: { homeRunnerId: presence === "id" || count === 1 ? homes[0] : null } },
          });
      }
      const current = client.dispatch({
        type: "browser.profile.create",
        idempotencyKey: "current",
        input: { name: "Current" },
      });
      if (count !== 1) await expect(current).rejects.toThrow();
      else await expect(current).resolves.toMatchObject({ profile: { homeRunnerId: homes[0] } });
    } finally {
      client.dispose();
    }
  });
});
