// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { PersonShowMessageSchema, computerAppIdentityKey } from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { VoiceController } from "@opensteer/client/voice";
import {
  click,
  client,
  element,
  goTo,
  history,
  mount,
  pageTab,
  placeParams,
  tabSearch,
} from "./workspace.interaction.test-support.js";

it.each(["app", "phone"] as const)(
  "opens the Run's current %s through shared navigation",
  async (kind) => {
    await mount("/");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    element<HTMLTextAreaElement>("[data-composer-input]").focus();
    const snapshot = client.getSnapshot();
    const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
    const machine = snapshot.machines.find((machine) =>
      machine.computerUse?.sessions.some((session) => session.display === (kind === "phone")),
    )!;
    const session = machine.computerUse!.sessions.find(
      (session) => session.display === (kind === "phone"),
    )!;
    const place =
      kind === "app"
        ? { kind, machineId: machine.id, appKey: computerAppIdentityKey(session.apps[0]!) }
        : { kind, machineId: machine.id, display: "main" };
    await act(async () =>
      client.receivePersonShow(
        PersonShowMessageSchema.parse({
          type: "host.show",
          workspaceId: source.workspaceId,
          threadId: source.id,
          runId: session.runId,
          target: { place, runId: session.runId },
        }),
      ),
    );
    const params = new URLSearchParams(history.at(-1)!.search);
    if (kind === "app") {
      expect(params.get("computerSession")).toBe(session.sessionId);
      expect(params.get("mac")).toBe(machine.id);
      expect(params.get("app")).toBe("appKey" in place ? place.appKey : null);
    } else {
      expect(params.get("computerSession")).toBeNull();
      expect(params.get("phone")).toBe(machine.id);
    }
  },
);

it("routes an authorized unloaded Thread through the existing Thread route", async () => {
  await mount("/");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  element<HTMLTextAreaElement>("[data-composer-input]").focus();
  const snapshot = client.getSnapshot();
  const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const threadId = createId("thread");
  await act(async () =>
    client.receivePersonShow(
      PersonShowMessageSchema.parse({
        type: "host.show",
        runId: createId("run"),
        workspaceId: source.workspaceId,
        threadId: source.id,
        target: { threadId },
      }),
    ),
  );
  expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
});

it.each(["Chat", "task"])(
  "shows a requested tab from %s while its composer has focus",
  async (route) => {
    await mount((host) =>
      route === "Chat"
        ? "/"
        : `/tasks/${host.getSnapshot().threads.find((thread) => thread.purpose === "task")!.id}`,
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const snapshot = client.getSnapshot();
    const threadId =
      route === "Chat" ? snapshot.homeThreadId! : history.at(-1)!.path.split("/").at(-1)!;
    const place = pageTab();
    if (place.destination.kind !== "browser") throw new Error("Expected a browser tab");
    const composer = element<HTMLTextAreaElement>("[data-composer-input]");
    composer.focus();
    expect(document.activeElement).toBe(composer);
    const before = history.length;
    await act(async () =>
      client.receivePersonShow(
        PersonShowMessageSchema.parse({
          type: "host.show",
          runId: createId("run"),
          workspaceId: snapshot.threads.find((thread) => thread.id === threadId)!.workspaceId,
          threadId,
          target: { tabId: place.destination.kind === "browser" ? place.destination.tabId : null },
        }),
      ),
    );
    expect(history).toHaveLength(before + 1);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  },
);

it("leaves other focused work, hidden windows and other conversations alone without replaying Show", async () => {
  await mount("/");
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const snapshot = client.getSnapshot();
  const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const target = snapshot.threads.find((thread) => thread.id !== source.id)!;
  const message = PersonShowMessageSchema.parse({
    type: "host.show",
    runId: createId("run"),
    workspaceId: source.workspaceId,
    threadId: source.id,
    target: { threadId: target.id },
  });
  const deliverIgnored = async () => {
    const before = history.length;
    await act(async () => client.receivePersonShow(message));
    expect(history).toHaveLength(before);
  };
  for (const tag of ["input", "textarea", "div", "iframe"] as const) {
    const field = document.createElement(tag);
    if (tag === "iframe") field.setAttribute("srcdoc", "<p>Browser page</p>");
    if (tag === "div") {
      field.setAttribute("contenteditable", "true");
      field.tabIndex = 0;
    }
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await deliverIgnored();
    if (tag === "div") {
      for (const mode of ["", "plaintext-only"]) {
        field.setAttribute("contenteditable", mode);
        await deliverIgnored();
      }
    }
    field.remove();
  }
  element<HTMLTextAreaElement>("[data-composer-input]").focus();
  visibility.mockReturnValue("hidden");
  await deliverIgnored();
  visibility.mockReturnValue("visible");
  focused.mockReturnValue(false);
  await deliverIgnored();
  focused.mockReturnValue(true);
  await act(async () => goTo!(`/tasks/${target.id}`));
  await deliverIgnored();
  await act(async () => goTo!("/settings/ai-engines"));
  await deliverIgnored();
  await act(async () => goTo!("/"));
  const before = history.length;
  await act(async () => undefined);
  expect(history).toHaveLength(before);
  await act(async () => client.receivePersonShow(message));
  expect(history.at(-1)!.path).toBe(`/tasks/${target.id}`);
});

it("keeps following its Run with a place over the conversation and the dock closed", async () => {
  await mount("/");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const snapshot = client.getSnapshot();
  const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const show = (target: object) =>
    act(async () =>
      client.receivePersonShow(
        PersonShowMessageSchema.parse({
          type: "host.show",
          runId: createId("run"),
          workspaceId: source.workspaceId,
          threadId: source.id,
          target,
        }),
      ),
    );
  const place = pageTab();
  if (place.destination.kind !== "browser") throw new Error("Expected a browser tab");
  await show({ tabId: place.destination.tabId });
  await click(element('[aria-label="Hide the conversation"]'));
  const threadId = createId("thread");
  await show({ threadId });
  expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
});

it("opens what the voice call's agent shows from any screen, and ignores a call it replaced", async () => {
  await mount("/");
  // The person talks while another window or a page holds focus.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const snapshot = client.getSnapshot();
  const home = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const target = snapshot.threads.find((thread) => thread.id !== home.id)!;
  const call = {
    threadId: createId("thread"),
    runId: createId("run"),
    workspaceId: home.workspaceId,
  };
  let current: typeof call | null = call;
  vi.spyOn(VoiceController.prototype, "call").mockImplementation(() => current);
  const showed = vi.spyOn(VoiceController.prototype, "showed");
  const show = (from: typeof call) =>
    PersonShowMessageSchema.parse({ type: "host.show", ...from, target: { threadId: target.id } });
  await act(async () => goTo!("/settings/ai-engines"));
  await act(async () => client.receivePersonShow(show(call)));
  expect(history.at(-1)!.path).toBe(`/tasks/${target.id}`);
  expect(showed).toHaveBeenCalledTimes(1);
  // One long Run can show again after the person changes screens.
  for (const path of ["/", `/tasks/${createId("thread")}`, "/settings/ai-engines"]) {
    await act(async () => goTo!(path));
    const before = history.length;
    await act(async () => client.receivePersonShow(show(call)));
    expect(history.length).toBeGreaterThan(before);
    expect(history.at(-1)!.path).toBe(`/tasks/${target.id}`);
  }
  expect(showed).toHaveBeenCalledTimes(4);

  await act(async () => goTo!("/"));
  const before = history.length;
  visibility.mockReturnValue("hidden");
  await act(async () => client.receivePersonShow(show(call)));
  visibility.mockReturnValue("visible");
  current = { ...call, runId: createId("run") };
  await act(async () => client.receivePersonShow(show(call)));
  expect(history).toHaveLength(before);
  expect(showed).toHaveBeenCalledTimes(4);
});
