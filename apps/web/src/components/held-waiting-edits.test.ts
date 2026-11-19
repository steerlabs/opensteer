import { hydrateWaitingDraft, openWaitingDraft, setWaitingDraftText } from "@opensteer/client/host";
import type { HostClient } from "@opensteer/client/host";
import type { ContentPart } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  heldEditScope,
  holdWaitingEdit,
  resetHeldWaitingEditsForTests,
  returnGoneWaitingEdits,
  takeWaitingEdit,
} from "./held-waiting-edits.js";

afterEach(resetHeldWaitingEditsForTests);

const photo: ContentPart = {
  artifactId: "a1",
  mediaType: "image/png",
  name: "photo.png",
  sizeBytes: 1,
  type: "artifact",
};

/** A client whose login and session the test moves, as a sign-out or viewer change would. */
function client() {
  const listeners = new Set<() => void>();
  const state = { scope: "login-a" as string | null, session: "authenticated" };
  const fake = {
    connection: {
      getSnapshot: () => ({
        scope: state.scope && {
          authorityKey: "host",
          deploymentId: "dep",
          viewerId: "user",
          loginId: state.scope,
        },
      }),
      subscribe: (listener: () => void) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
    },
    getSnapshot: () => ({ session: state.session }),
    subscribe: (listener: () => void) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
  } as unknown as HostClient;
  return {
    fake,
    move: (change: Partial<typeof state>) => {
      Object.assign(state, change);
      for (const listener of listeners) listener();
    },
  };
}

const typed = (text: string) =>
  setWaitingDraftText(
    hydrateWaitingDraft(openWaitingDraft({ content: [], revision: 1 }), {
      content: [{ type: "text", text: "Old" }, photo],
      revision: 1,
      full: true,
    }),
    text,
  );

it("hands a gone message's words to the composer and lets its lease go; a waiting one stays held", () => {
  const { fake } = client();
  const released = { gone: vi.fn(), waiting: vi.fn() };
  holdWaitingEdit(fake, "scope", "thread", "gone", {
    draft: typed("My words"),
    release: released.gone,
    session: {},
  });
  holdWaitingEdit(fake, "scope", "thread", "waiting", {
    draft: typed("Still mine"),
    release: released.waiting,
    session: {},
  });
  const handBack = vi.fn();
  returnGoneWaitingEdits("scope", "thread", ["waiting"], handBack);
  expect(released.gone).toHaveBeenCalledOnce();
  expect(handBack).toHaveBeenCalledOnce();
  const returned = handBack.mock.calls[0]![0];
  expect(returned.edit("")).toBe("My words");
  expect(returned.edit("Already in the composer")).toBe("My words\n\nAlready in the composer");
  expect(returned.files).toEqual([
    { mediaType: "image/png", name: "photo.png", part: photo, sizeBytes: 1 },
  ]);
  expect(released.waiting).not.toHaveBeenCalled();
  expect(takeWaitingEdit("scope", "thread", "waiting")).toBeDefined();
});

it("never hands a locked preview to the composer", () => {
  const { fake } = client();
  const release = vi.fn();
  holdWaitingEdit(fake, "scope", "thread", "gone", {
    draft: openWaitingDraft({ content: [{ type: "text", text: "Clipped pre" }], revision: 2 }),
    release,
    session: {},
  });
  const handBack = vi.fn();
  returnGoneWaitingEdits("scope", "thread", [], handBack);
  expect(release).toHaveBeenCalledOnce();
  expect(handBack).not.toHaveBeenCalled();
});

it("lets every held edit go on sign-out or another login, but keeps them while no login is known", () => {
  const { fake, move } = client();
  const scope = heldEditScope(fake)!;
  const release = vi.fn();
  holdWaitingEdit(fake, scope, "thread", "m", { draft: typed("Mine"), release, session: {} });
  // A same-viewer rollback passes through no known login.
  move({ scope: null });
  move({ scope: "login-a" });
  expect(release).not.toHaveBeenCalled();
  expect(takeWaitingEdit(scope, "thread", "m")).toBeDefined();
  holdWaitingEdit(fake, scope, "thread", "m", { draft: typed("Mine"), release, session: {} });
  move({ scope: "login-b" });
  expect(release).toHaveBeenCalledOnce();
  expect(takeWaitingEdit(scope, "thread", "m")).toBeUndefined();

  const signedOut = vi.fn();
  move({ scope: "login-a" });
  holdWaitingEdit(fake, scope, "thread", "m", {
    draft: typed("Mine"),
    release: signedOut,
    session: {},
  });
  move({ session: "authentication-required" });
  expect(signedOut).toHaveBeenCalledOnce();
});
