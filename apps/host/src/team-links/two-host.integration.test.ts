import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { createTwoHostLinkFixture } from "./two-host.test-support.js";

describe("personal to team link", () => {
  it("converges duplicate delivery, reconnect and edited context; reuses the thread and freezes its folder", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      await expect(
        f.folders.set(f.team.deploymentId, f.channelId, {
          computerId: createId("runner"),
          path: "/tmp/elsewhere",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const first = await f.ask();
      await f.deliver(first);
      await f.deliver(first);
      expect(await f.inputCount()).toBe(1);
      const original = await f.local(first);
      expect(await f.taskFolder(original.taskId)).toEqual(f.personal.agentHome);
      await f.folders.set(f.team.deploymentId, f.channelId, {
        ...f.personal.agentHome,
        path: "/tmp/PRIVATE_SENTINEL/new-folder",
      });
      await f.editContext("Revised instructions", "Edited question");
      await f.deliver(first);
      const second = await f.ask(first.threadRootId);
      await f.deliver(second);
      expect((await f.local(second)).taskId).toBe(original.taskId);
      expect(await f.taskFolder(original.taskId)).toEqual(f.personal.agentHome);
      const third = await f.ask();
      await f.deliver(third);
      expect(await f.taskFolder((await f.local(third)).taskId)).toEqual({
        ...f.personal.agentHome,
        path: "/tmp/PRIVATE_SENTINEL/new-folder",
      });
      expect(await f.inputCount()).toBe(3);
      await f.run(first, "Public answer");
      expect(f.startedContexts.at(-1)?.instructionsMarkdown).toBe("Revised instructions");
      expect(f.wire()).not.toMatch(
        /PRIVATE_SENTINEL|PRIVATE_TRANSCRIPT|ost_link_|credentialReference/,
      );
    } finally {
      await f.close();
    }
  });

  it("keeps an offline request queued and admits it on the next outbound socket", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      expect(await f.inputCount()).toBe(0);
      await f.connect();
      await f.waitForInput(request.id);
      await f.disconnect();
      await f.connect();
      await f.waitForInput(request.id);
      expect(await f.inputCount()).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("retrieves the completed reply after a lost acknowledgement without another Run", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      await f.deliver(request);
      f.loseReplyAcknowledgement();
      await expect(f.run(request, "One reply")).rejects.toMatchObject({ code: "runner_offline" });
      expect((await f.local(request)).publicationState).toBe("pending");
      await f.deliver(request);
      await f.reconnect();
      expect((await f.local(request)).publicationState).toBe("accepted");
      expect(await f.replyCount(request.id)).toBe(1);
      expect(f.runCount).toBe(1);
    } finally {
      await f.close();
    }
  });

  it.each(["failed", "stopped"] as const)(
    "publishes a local %s outcome after an offline restart without rerunning",
    async (state) => {
      const f = await createTwoHostLinkFixture();
      try {
        const request = await f.ask();
        await f.deliver(request);
        f.offline = true;
        await expect(f.run(request, null, state)).rejects.toMatchObject({ code: "runner_offline" });
        f.offline = false;
        await f.reconnect();
        expect((await f.teamRequest(request.id)).state).toBe(state);
        expect((await f.local(request)).publicationState).toBe("accepted");
        expect(f.runCount).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["revoke", "remove"] as const)(
    "cuts authority and publication during a Run on %s",
    async (action) => {
      const f = await createTwoHostLinkFixture();
      try {
        const request = await f.ask();
        await f.deliver(request);
        await f.run(request, null, "working");
        await f.cut(action);
        await f.finish(request, "Keep this answer privately");
        expect((await f.local(request)).publicationState).toBe("blocked");
        expect(await f.replyCount(request.id)).toBe(0);
        expect(await f.privateAnswer(request.id)).toBe("Keep this answer privately");
        await expect(f.call({ type: "context", requestId: request.id })).rejects.toMatchObject({
          code: "unauthorized",
        });
      } finally {
        await f.close();
      }
    },
  );

  it("redeems one code and hash idempotently, refuses replacement hashes, and revokes the previous link", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const first = await f.redeemAgain();
      expect(first.id).toBe(f.linkId);
      await expect(f.redeemAgain("a".repeat(64))).rejects.toMatchObject({ code: "unauthorized" });
      const replacement = await f.replaceLink();
      expect(replacement.id).not.toBe(f.linkId);
      await expect(f.links.authenticate(f.secret)).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      await f.close();
    }
  });

  it("cancels an accepted local input when its team request ended while disconnected", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      await f.deliver(request);
      await f.cancelOnTeam(request);
      await f.reconnect();
      expect(await f.inputState(request)).toBe("cancelled");
      expect((await f.local(request)).publicationState).toBe("blocked");
      expect((await f.local(request)).terminalState).toBe("cancelled");
      await f.deliver(request);
      expect(await f.inputCount()).toBe(1);
      expect(f.runCount).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("discards a buffered SQL result when its topic authority shrinks before handoff", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      await f.deliver(request);
      await f.sqlFence(request);
    } finally {
      await f.close();
    }
  });

  it("keeps authority on the request Run and uses an explicit team reply once", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      await f.deliver(request);
      await f.run(request, null, "working");
      await f.authorityMatrix(request);
    } finally {
      await f.close();
    }
  });

  it("throttles live steps and immediately publishes needs-you without private details", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      const request = await f.ask();
      await f.deliver(request);
      await f.safeProgress(request);
    } finally {
      await f.close();
    }
  });

  it("keeps the minted secret through a lost redeem response and leaves with revoke-only retries", async () => {
    const f = await createTwoHostLinkFixture();
    try {
      await f.joinRoundTrip();
    } finally {
      await f.close();
    }
  });

  it.each(["revoke", "remove"] as const)(
    "authenticates binary routes and cancels streams on %s",
    async (removal) => {
      const f = await createTwoHostLinkFixture();
      try {
        const request = await f.ask();
        await f.deliver(request);
        await f.binaryMatrix(request, removal);
      } finally {
        await f.close();
      }
    },
  );
});
