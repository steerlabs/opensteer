// @vitest-environment happy-dom

import { createId, emptyExecutionPreferences, RunnerIdSchema, type Request } from "@opensteer/core";
import type { PasswordSignInAccount } from "@opensteer/client/host";
import { MockHostClient, mockPasswordSignInRequest } from "@opensteer/client/mock";
import type { PasswordSignInRequestResponse } from "@opensteer/protocol";
import {
  DesktopDeploymentSummarySchema,
  type DesktopPasswordsSignInApproveResult,
  type DesktopPasswordsSignInCardState,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellContext } from "./app-shell.js";
import { InputSurface } from "./input-surface.js";
import {
  PasswordSignInRequestBody,
  type PasswordSignInCardBridge,
  type PasswordSignInRequestClient,
} from "./thread-password-sign-in-action.js";

/*
 * How the saved-password sign-in card could mislead or misfire (the full list
 * is in the workstream report; each is covered below):
 * - it draws the Mac's controls in a browser tab on that Mac, in the desktop
 *   app on another computer, or in one lending another Runner, or withholds
 *   them from the desktop app on that Mac;
 * - it offers Allow before the Mac's state is read, or for accounts the Mac
 *   never sent; with several accounts it chooses one for the person (Allow
 *   remembers it), lets Allow or Return through before a choice, or keeps a
 *   choice the Mac no longer sends; it forgets the chosen account when the
 *   same list arrives again; one account needs a choice at all;
 * - a long list buries the actions: every row repeats its host, accounts for
 *   the site's other services (AWS on amazon.com) sit among the page's, the
 *   site's accounts hide behind a disclosure when none is for the page, or
 *   there is no way to narrow forty accounts;
 * - the filter crowds a short list, vanishes while it holds text, answers
 *   Return with Allow or Esc with Don’t allow while it holds text, or hides
 *   the other hosts' matches behind a closed disclosure;
 * - the card says what Allow keeps before there is an account to keep, or
 *   in words that do not name the account;
 * - a long username pushes the row wider than the card, or loses its middle
 *   for assistive technology; rows on other hosts lose their host for a
 *   screen reader, or the list has no single group name;
 * - Allow and Only this time swap `remember`, approve another login or
 *   revision than shown, run twice, or lose `{ok: false}` and leave the card;
 * - an approval answer replaces a newer state the Mac pushed, or a slow
 *   read replaces a newer push;
 * - with no saved account it offers Allow;
 * - Don’t allow sends anything but `browser.password-sign-in.decline`,
 *   twice, or with a new key on retry;
 * - a gone sign-in or a failed read leaves no way out;
 * - Return answers twice or from the wrong stage; Esc declines outside the
 *   approval;
 * - it keeps listening after it closes or settles;
 * - the agent's reason is unlabelled or repeated, the privacy line does not
 *   name the site, or a settled sign-in reads in the wrong words.
 */

const otherRunnerId = RunnerIdSchema.parse("rnr_44444444-4444-4444-8444-444444444444");
const threadId = "thr_00000000-0000-4000-8000-000000000004";
const noOp = () => undefined;
const roots: Root[] = [];

const alex = account({ revision: 3, username: "alex@example.com" });
const work = account({
  label: "Work",
  revision: 7,
  username: "alex.demo+a-very-long-alias@corporate-example-holdings.com",
});
const approval = (
  accounts: readonly PasswordSignInAccount[] = [alex, work],
  site = "https://github.com",
): DesktopPasswordsSignInCardState => ({ accounts: [...accounts], site, stage: "approval" });

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-11T09:00:00.000Z"));
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the saved-password sign-in card elsewhere", () => {
  it("names the Mac, the agent's reason and the expiry, and declines from anywhere", async () => {
    const client = new MockHostClient({ latencyMs: 0, pendingRequests: [pending()] });
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await mountSurface({ client });

    expect(page.querySelector(".action-panel__title")?.textContent).toBe("Sign in to github.com");
    expect(text(page)).toContain("Agent’s reason");
    // The reason is the agent's, said once, in the card under its label.
    expect(occurrences(text(page), "Download the October statement")).toBe(1);
    expect(text(page)).toContain(
      "Opensteer fills your password into github.com for them — it never sends it to the agent, but the website page holds it once filled. Sign-ins can stay saved in the browser profile.",
    );
    expect(text(page)).toContain("Expires in 14 minutes");
    expect(text(page)).toContain("Waiting for you on Mac mini");
    expect(text(page)).not.toContain("this Mac");
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);

    await click(button(page, "Don’t allow"));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      requestId: pending().id,
      type: "browser.password-sign-in.decline",
    });
    expect(client.getSnapshot().requests[threadId] ?? []).toEqual([]);
    expect(client.getSnapshot().transcripts[threadId]?.at(-1)).toEqual(
      expect.objectContaining({ outcome: "Not allowed", requestKind: "browser.password-sign-in" }),
    );
  });

  it("is the approval only in the desktop app on the Mac that runs it", async () => {
    const fake = fakeMac(approval());

    // A browser tab on that very Mac cannot reach Passwords.
    const tab = await mountSurface({ hostsDeploymentHere: true });
    expect(buttonTexts(tab)).toEqual(["Don’t allow"]);
    expect(text(tab)).toContain("Waiting for you on Mac mini");

    // The desktop app, opening this Opensteer from another computer.
    const elsewhere = await mountSurface({ desktopBridge: fake.bridge });
    expect(buttonTexts(elsewhere)).toEqual(["Don’t allow"]);

    // The desktop app lending some other Runner is not that Mac either.
    const lent = await mountSurface({ desktopBridge: fake.bridge, localRunnerId: otherRunnerId });
    expect(buttonTexts(lent)).toEqual(["Don’t allow"]);
    expect(fake.bridge.passwordsSignInGet).not.toHaveBeenCalled();

    const here = await mountSurface({ desktopBridge: fake.bridge, hostsDeploymentHere: true });
    expect(fake.bridge.passwordsSignInGet).toHaveBeenCalledExactlyOnceWith({
      operationId: operationId(),
    });
    expect(text(here)).not.toContain("Waiting for you");
    expect(buttonTexts(here)).toEqual(["Don’t allow", "Only this time", "Allow"]);
    // What Allow keeps is said once there is an account to keep, and of that account.
    expect(text(here)).not.toContain("Allow lets agents");
    await click(radios(here)[0]!.input);
    expect(text(here)).toContain(
      "Allow lets agents in Finance & operations sign in as alex@example.com from now on.",
    );
  });
});

describe("the saved-password sign-in card on the Mac", () => {
  it("draws nothing to approve until the Mac answers", async () => {
    const fake = fakeMac(approval());
    let answer: ((state: DesktopPasswordsSignInCardState) => void) | undefined;
    fake.bridge.passwordsSignInGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const page = await mountBody({ mac: fake.bridge });
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);
    expect(page.querySelector(".spinner")).toBeNull();
    await act(async () => answer?.(approval()));
    expect(buttonTexts(page)).toEqual(["Don’t allow", "Only this time", "Allow"]);
  });

  it("chooses nothing for the person among several accounts, and keeps their choice", async () => {
    const fake = fakeMac(approval([alex, work, account({ username: "jo@example.com" })]));
    const page = await mountBody({ mac: fake.bridge });
    const options = radios(page);
    expect(options.map(({ name }) => name)).toEqual([
      "alex@example.com",
      work.username,
      "jo@example.com",
    ]);
    expect(options.map(({ input }) => input.checked)).toEqual([false, false, false]);
    // One group, one name: arrow keys move through every account.
    expect(new Set(options.map(({ input }) => input.name)).size).toBe(1);
    expect(groupName(page)).toBe("Sign in as");
    expect(button(page, "Allow").disabled).toBe(true);
    expect(button(page, "Only this time").disabled).toBe(true);
    // Return with nothing chosen allows nothing.
    await key(options[0]!.input, "Enter");
    expect(fake.bridge.passwordsSignInApprove).not.toHaveBeenCalled();

    await click(options[1]!.input);
    expect(button(page, "Allow").disabled).toBe(false);
    // The same list again, as the Mac repeats it: the choice stands.
    await act(async () => fake.push(approval([alex, work])));
    expect(radios(page).map(({ input }) => input.checked)).toEqual([false, true]);
    // The chosen account is gone: nothing is chosen again.
    await act(async () => fake.push(approval([alex, account({ username: "jo@example.com" })])));
    expect(radios(page).map(({ input }) => input.checked)).toEqual([false, false]);
    expect(button(page, "Allow").disabled).toBe(true);
  });

  it("names the only account in a sentence, ready to allow", async () => {
    const fake = fakeMac(approval([alex]));
    const page = await mountBody({ mac: fake.bridge });
    expect(radios(page)).toEqual([]);
    expect(page.querySelector(".sign-in-card__lead")?.textContent).toBe(
      "Sign in as alex@example.com",
    );
    expect(document.activeElement?.textContent).toBe("Allow");
    await click(button(page, "Allow"));
    expect(fake.bridge.passwordsSignInApprove).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ loginId: alex.id, remember: true, revision: 3 }),
    );
  });

  it("shows a long username whole to assistive technology, cut only in the middle", async () => {
    const page = await mountBody({ mac: fakeMac(approval()).bridge });
    const long = radios(page)[1]!;
    expect(long.name).toBe(work.username);
    const shown = long.option.querySelector<HTMLElement>(".account-name")!;
    expect(shown.title).toBe(work.username);
    expect(shown.textContent).toBe(work.username);
    // The end of the address stays in view when the start is cut.
    expect(shown.querySelector(".account-name__end")?.textContent).toBe("-holdings.com");
    expect(long.option.querySelector(".account-choice__detail")?.textContent).toBe("Work");
  });

  it("lists the page's accounts first and the site's other services behind one disclosure", async () => {
    const page = await mountBody({
      mac: fakeMac(approval(amazon, "https://amazon.com")).bridge,
      request: onAmazon(),
    });
    const visible = radios(page).filter(({ option }) => option.closest("details") === null);
    expect(visible.map(({ name }) => name)).toEqual([
      "jordan3696@example.com",
      "morgan@example.com",
      "alex@company.example",
      "alex901@example.com",
    ]);
    // No row on the page repeats a host.
    expect(visible.map(({ option }) => option.textContent)).toEqual(
      visible.map(({ name }) => name),
    );
    const others = page.querySelector<HTMLDetailsElement>(".account-choice details")!;
    expect(others.open).toBe(false);
    expect(others.querySelector("summary")?.textContent).toBe("Other accounts on amazon.com (7)");
    expect(
      [...others.querySelectorAll(".account-choice__host")].map(({ textContent }) => textContent),
    ).toEqual([
      "portal.aws.amazon.com",
      "signin.aws.amazon.com",
      "us-east-1.signin.aws.amazon.com",
    ]);
    // Each row behind it is described by its host, said once as a heading.
    const aws = radios(page).find(
      ({ name, option }) => name === "alex@company.example" && option.closest("details") !== null,
    )!;
    expect(describedBy(aws.input)).toBe("signin.aws.amazon.com");
    const newest = radios(page).find(({ option }) => option.textContent?.includes("Mar 2026"))!;
    expect(describedBy(newest.input)).toBe("signin.aws.amazon.com Updated Mar 2026");
    expect(groupName(page)).toBe("Sign in as");
  });

  it("lists the site's accounts by host, in view, when none is for the page", async () => {
    const offPage = [...amazon.slice(4), ...amazon.slice(0, 4)].map((entry) => ({
      ...entry,
      onPage: false,
    }));
    const page = await mountBody({
      mac: fakeMac(approval(offPage, "https://amazon.com")).bridge,
      request: onAmazon(),
    });
    expect(page.querySelector(".account-choice details")).toBeNull();
    expect(
      [...page.querySelectorAll(".account-choice__host")].map(({ textContent }) => textContent),
    ).toEqual([
      "portal.aws.amazon.com",
      "signin.aws.amazon.com",
      "us-east-1.signin.aws.amazon.com",
      "www.amazon.com",
    ]);
    expect(radios(page)).toHaveLength(11);
  });

  it("offers a filter once more than eight accounts are in view", async () => {
    const page = await mountBody({
      mac: fakeMac(approval(amazon, "https://amazon.com")).bridge,
      request: onAmazon(),
    });
    // Four on the page, seven folded away: nothing to narrow yet.
    expect(page.querySelector(".account-choice__filter")).toBeNull();
    expect(document.activeElement).toBe(radios(page)[0]!.input);
    const others = page.querySelector<HTMLDetailsElement>(".account-choice details")!;
    await act(async () => {
      others.open = true;
      others.dispatchEvent(new Event("toggle"));
    });
    expect(page.querySelector(".account-choice__filter")).not.toBeNull();
  });

  it("filters a long list without answering the card from the filter", async () => {
    const fake = fakeMac(approval(crowded, "https://amazon.com"));
    const dispatch = vi.fn(() => new Promise(() => undefined));
    const page = await mountBody({ dispatch, mac: fake.bridge, request: onAmazon() });
    const filter = page.querySelector<HTMLInputElement>(".account-choice__filter")!;
    expect(filter.getAttribute("aria-label")).toBe("Filter accounts");
    // Many accounts: the filter takes focus, so typing narrows at once.
    expect(document.activeElement).toBe(filter);

    await type(filter, "ALEX@EXAMPLE.COM");
    const matches = radios(page);
    expect(matches.map(({ name }) => name)).toEqual(Array(6).fill("alex@example.com"));
    // Matches on the site's other hosts are in view while the filter holds text.
    expect(page.querySelector<HTMLDetailsElement>(".account-choice details")?.open).toBe(true);

    await click(matches[2]!.input);
    await type(filter, "alex@example.com ");
    // Return in the filter never allows; Esc there clears it before it declines.
    await key(filter, "Enter");
    expect(fake.bridge.passwordsSignInApprove).not.toHaveBeenCalled();
    await key(filter, "Escape");
    expect(filter.value).toBe("");
    expect(dispatch).not.toHaveBeenCalled();
    expect(page.querySelector<HTMLDetailsElement>(".account-choice details")?.open).toBe(false);

    await type(filter, "901");
    // Return chooses the only match, and the next Return allows it.
    await key(filter, "Enter");
    expect(radios(page).map(({ input }) => input.checked)).toEqual([true]);
    // The filter stays while it holds text, though one account is left.
    expect(page.querySelector(".account-choice__filter")).toBe(filter);
    expect(document.activeElement).toBe(radios(page)[0]!.input);
    await key(radios(page)[0]!.input, "Enter");
    expect(fake.bridge.passwordsSignInApprove).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ loginId: amazon[3]!.id, remember: true }),
    );

    await act(async () => fake.push(approval(crowded, "https://amazon.com")));
    const again = page.querySelector<HTMLInputElement>(".account-choice__filter")!;
    await type(again, "nobody");
    expect(radios(page)).toEqual([]);
    expect(text(page)).toContain("No account matches “nobody”");
    await key(again, "Escape");
    await key(again, "Escape");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("offers no filter for eight accounts or fewer", async () => {
    const eight = Array.from({ length: 8 }, (_, index) => account({ username: `u${index}@x.com` }));
    const page = await mountBody({ mac: fakeMac(approval(eight)).bridge });
    expect(page.querySelector(".account-choice__filter")).toBeNull();
    expect(radios(page)).toHaveLength(8);
  });

  it("allows the chosen account, remembered, after Touch ID, and says it authorized the account", async () => {
    const fake = fakeMac(approval());
    let answer: ((result: DesktopPasswordsSignInApproveResult) => void) | undefined;
    fake.bridge.passwordsSignInApprove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const page = await mountBody({ mac: fake.bridge });
    await click(radios(page)[1]!.input);
    await click(button(page, "Allow"));
    expect(text(page)).toContain("Confirm with Touch ID or your Mac password.");
    // Nothing answers twice while the Mac asks.
    expect(buttonTexts(page).map((label) => button(page, label).disabled)).toEqual([
      true,
      true,
      true,
    ]);
    await click(button(page, "Allow"));
    expect(fake.bridge.passwordsSignInApprove).toHaveBeenCalledExactlyOnceWith({
      loginId: work.id,
      operationId: operationId(),
      remember: true,
      revision: 7,
    });

    await act(async () => answer?.({ ok: true }));
    expect(text(page)).toContain(`Allowed agents to sign in as ${work.username}`);
    expect(text(page)).not.toContain("Confirm with Touch ID");
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);
  });

  it("asks once with Only this time, and keeps the card when the Mac says no", async () => {
    const fake = fakeMac(approval());
    fake.bridge.passwordsSignInApprove
      .mockResolvedValueOnce({ message: "Touch ID was cancelled.", ok: false })
      .mockRejectedValueOnce(new Error("Opensteer Passwords isn’t responding."));
    const page = await mountBody({ mac: fake.bridge });

    await click(radios(page)[0]!.input);
    await click(button(page, "Only this time"));
    expect(fake.bridge.passwordsSignInApprove).toHaveBeenLastCalledWith({
      loginId: alex.id,
      operationId: operationId(),
      remember: false,
      revision: 3,
    });
    expect(page.querySelector("[role=alert]")?.textContent).toBe("Touch ID was cancelled.");
    expect(buttonTexts(page)).toEqual(["Don’t allow", "Only this time", "Allow"]);
    expect(button(page, "Allow").disabled).toBe(false);

    await click(button(page, "Allow"));
    expect(page.querySelector("[role=alert]")?.textContent).toBe(
      "Opensteer Passwords isn’t responding.",
    );
    expect(button(page, "Allow").disabled).toBe(false);
  });

  it("never lets an answer or a slow read replace a newer state from the Mac", async () => {
    const fake = fakeMac(approval());
    let answer: ((result: DesktopPasswordsSignInApproveResult) => void) | undefined;
    fake.bridge.passwordsSignInApprove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const page = await mountBody({ mac: fake.bridge });
    await click(radios(page)[0]!.input);
    await click(button(page, "Allow"));
    await act(async () => fake.push({ account: "j•••@example.com", stage: "authorized" }));
    await act(async () => answer?.({ ok: true }));
    expect(text(page)).toContain("Allowed agents to sign in as j•••@example.com");
    expect(text(page)).not.toContain("Signing in as");

    let read: ((state: DesktopPasswordsSignInCardState) => void) | undefined;
    const late = fakeMac(approval());
    late.bridge.passwordsSignInGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          read = resolve;
        }),
    );
    const other = await mountBody({ mac: late.bridge });
    await act(async () => late.push({ account: "t•••@example.com", stage: "authorized" }));
    await act(async () => read?.(approval()));
    expect(text(other)).toContain("Allowed agents to sign in as t•••@example.com");
  });

  it.each(["t•••@example.com", "w•••@example.com"])(
    "keeps its authorization line quietly while the Request settles (%j)",
    async (username) => {
      const fake = fakeMac({ account: username, stage: "authorized" });
      const dispatch = vi.fn(() => new Promise(() => undefined));
      const page = await mountBody({ dispatch, mac: fake.bridge });
      const region = page.querySelector<HTMLElement>(".sign-in-card__state")!;
      const before = region.innerHTML;
      const announced: MutationRecord[] = [];
      const observer = new MutationObserver((records) => announced.push(...records));
      observer.observe(region, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      // The Mac lets go of a sign-in it finished just before the Host settles its Request.
      await act(async () => fake.push({ stage: "gone" }));
      await act(async () => undefined);

      // Failure mode: every finished sign-in flashes "no longer running", and
      // the live region announces it.
      expect(text(page)).not.toContain("no longer running");
      expect(announced).toEqual([]);
      expect(region.innerHTML).toBe(before);
      expect(text(page)).not.toContain("Expires in");
      // Failure mode: Stop declines a sign-in the Mac already finished.
      expect(buttonTexts(page)).toEqual(["Don’t allow"]);
      expect(button(page, "Don’t allow").disabled).toBe(true);
      await click(button(page, "Don’t allow"));
      expect(dispatch).not.toHaveBeenCalled();
      observer.disconnect();
    },
  );

  it.each([["approval", approval()]] as const)(
    "says a sign-in the Mac dropped from %s is no longer running, and lets the person clear it",
    async (_stage, initial) => {
      const fake = fakeMac(initial);
      const dispatch = vi.fn(() => new Promise(() => undefined));
      const page = await mountBody({ dispatch, mac: fake.bridge });
      await act(async () => fake.push({ stage: "gone" }));
      expect(text(page)).toContain("This sign-in is no longer running on this Mac.");
      expect(buttonTexts(page)).toEqual(["Don’t allow"]);
      await click(button(page, "Don’t allow"));
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it("lets the person clear a sign-in the Mac no longer runs", async () => {
    const fake = fakeMac({ stage: "gone" });
    const page = await mountBody({ mac: fake.bridge });
    expect(text(page)).toContain("This sign-in is no longer running on this Mac.");
    expect(text(page)).not.toContain("Expires in");
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);
  });

  it("says a failed read with Try again, and keeps Don’t allow", async () => {
    const fake = fakeMac(new Error("The Opensteer app couldn’t reach Passwords."));
    const page = await mountBody({ mac: fake.bridge });
    expect(page.querySelector("[role=alert] span")?.textContent).toBe(
      "The Opensteer app couldn’t reach Passwords.",
    );
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);
    fake.set(approval());
    await click(button(page, "Try again"));
    expect(fake.bridge.passwordsSignInGet).toHaveBeenCalledTimes(2);
    expect(page.querySelector("[role=alert]")).toBeNull();
    expect(buttonTexts(page)).toEqual(["Don’t allow", "Only this time", "Allow"]);
  });

  it("answers Return with the highlighted action and Esc with Don’t allow", async () => {
    const fake = fakeMac(approval());
    const dispatch = vi.fn(() => new Promise(() => undefined));
    const page = await mountBody({ dispatch, mac: fake.bridge });
    // With several accounts the list takes focus as the stage appears.
    expect(document.activeElement).toBe(radios(page)[0]!.input);

    await click(radios(page)[1]!.input);
    // Return on a focused button is that button's own; the card adds nothing.
    await key(button(page, "Don’t allow"), "Enter");
    expect(fake.bridge.passwordsSignInApprove).not.toHaveBeenCalled();
    await key(radios(page)[1]!.input, "Enter");
    expect(fake.bridge.passwordsSignInApprove).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ loginId: work.id, remember: true }),
    );
    await act(async () => fake.push(approval()));
    await key(radios(page)[0]!.input, "Escape");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("leaves the composer's focus alone while the person types", async () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    await mountBody({ mac: fakeMac(approval()).bridge });
    expect(document.activeElement).toBe(composer);
  });

  it("stops listening once it closes or its Request settles", async () => {
    const fake = fakeMac(approval());
    const container = await mountBody({ mac: fake.bridge });
    expect(fake.listeners.size).toBe(1);
    await act(async () =>
      roots.at(-1)?.render(
        body({
          mac: fake.bridge,
          request: resolved({ method: "saved-password", outcome: "signed-in" }),
        }),
      ),
    );
    expect(fake.listeners.size).toBe(0);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Signed in to github.com");
    await mountBody({ mac: fake.bridge });
    expect(fake.listeners.size).toBe(1);
    for (const root of roots.splice(0)) act(() => root.unmount());
    expect(fake.listeners.size).toBe(0);
  });
});

describe("the card's decline and its endings", () => {
  it("declines once, says so while it waits, and retries with the same key", async () => {
    let answer: ((value: unknown) => void) | undefined;
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("The Host could not be reached."))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
    const page = await mountBody({ dispatch });

    await click(button(page, "Don’t allow"));
    expect(page.querySelector("[role=alert]")?.textContent).toBe("The Host could not be reached.");
    expect(button(page, "Don’t allow").disabled).toBe(false);

    await click(button(page, "Don’t allow"));
    expect(button(page, "Declining…").disabled).toBe(true);
    expect(page.querySelector("[role=alert]")).toBeNull();
    await click(button(page, "Declining…"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0].idempotencyKey,
    );

    // The Mac has not answered yet: the card keeps saying so until the Request settles.
    await act(async () =>
      answer?.({ status: "pending", type: "browser.password-sign-in.decline" }),
    );
    expect(button(page, "Declining…").disabled).toBe(true);
  });

  it("says Expired once the deadline passes, and stops offering to sign in", async () => {
    const page = await mountBody({ mac: fakeMac(approval()).bridge });
    expect(text(page)).toContain("Expires in 14 minutes");
    await act(async () => vi.advanceTimersByTime(13 * 60_000 + 30_000));
    expect(text(page)).toContain("Expires in less than a minute");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(text(page)).toContain("Expired");
    expect(text(page)).not.toContain("Expires in");
    expect(buttonTexts(page)).toEqual(["Don’t allow"]);
  });

  const settled: readonly [Request, string][] = [
    [resolved({ method: "saved-password", outcome: "signed-in" }), "Signed in to github.com"],
    [resolved({ method: "person", outcome: "signed-in" }), "You signed in to github.com"],
    [mockPasswordSignInRequest({ status: "declined" }), "Not allowed"],
    [resolved({ outcome: "expired" }), "This sign-in timed out"],
    [
      resolved({ outcome: "failed", reason: "wrong-password" }),
      "github.com didn’t accept the saved password",
    ],
    [
      resolved({ outcome: "failed", reason: "unsupported-page" }),
      "Opensteer couldn’t find where to sign in on github.com",
    ],
    [
      resolved({ outcome: "failed", reason: "blocked-destination" }),
      "The page tried to reach a blocked address, so nothing was handed to the agent",
    ],
    [
      resolved({ outcome: "failed", reason: "cleanup-failed" }),
      "The private sign-in couldn’t be cleared, so nothing was handed to the agent",
    ],
    [resolved({ outcome: "failed", reason: "busy" }), "Too many sign-ins at once"],
    [
      resolved({ outcome: "failed", reason: "needs-fresh-session" }),
      "This needs a new browser session. Ask your agent to open one and try again",
    ],
    [
      resolved({ outcome: "unavailable", reason: "passwords-off" }),
      "Agent sign-ins are off on Mac mini",
    ],
    [resolved({ outcome: "outcome-unknown" }), "Opensteer couldn’t confirm the sign-in"],
    [resolved({ outcome: "session-closed" }), "The agent’s browser closed"],
    [resolved({ outcome: "interrupted" }), "The sign-in stopped on Mac mini"],
  ];

  it.each(settled)("draws a settled sign-in in its own words: %#", async (request, words) => {
    const page = await mountBody({ request });
    expect(page.querySelector("[role=status]")?.textContent).toBe(words);
    expect(page.querySelectorAll("button")).toHaveLength(0);
  });
});

function pending(): Request {
  return mockPasswordSignInRequest({ expiresAt: "2026-10-11T09:14:00.000Z" });
}

function onAmazon(): Request {
  return mockPasswordSignInRequest({
    expiresAt: "2026-10-11T09:14:00.000Z",
    site: "https://amazon.com",
  });
}

function operationId(): string {
  const { payload } = pending();
  if (payload.kind !== "browser.password-sign-in") throw new Error("Not a sign-in");
  return payload.operationId;
}

function resolved(response: PasswordSignInRequestResponse): Request {
  return mockPasswordSignInRequest({ response, status: "fulfilled" });
}

/** The Mac's side of one sign-in: what it reads, what it pushes, what it was asked. */
function fakeMac(initial: DesktopPasswordsSignInCardState | Error) {
  let current = initial;
  const listeners = new Set<(state: DesktopPasswordsSignInCardState) => void>();
  const bridge = {
    onPasswordsSignInChanged: vi.fn(
      (
        _input: { readonly operationId: string },
        listener: (state: DesktopPasswordsSignInCardState) => void,
      ) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    ),
    passwordsSignInApprove: vi.fn(async (): Promise<DesktopPasswordsSignInApproveResult> => ({
      ok: true,
    })),
    passwordsSignInGet: vi.fn(async (): Promise<DesktopPasswordsSignInCardState> => {
      if (current instanceof Error) throw current;
      return current;
    }),
  } satisfies PasswordSignInCardBridge;
  return {
    bridge,
    listeners,
    push: (state: DesktopPasswordsSignInCardState) => {
      current = state;
      for (const listener of listeners) listener(state);
    },
    set: (state: DesktopPasswordsSignInCardState) => {
      current = state;
    },
  };
}

interface BodyInput {
  readonly dispatch?: ReturnType<typeof vi.fn>;
  readonly mac?: PasswordSignInCardBridge;
  readonly request?: Request;
}

function body(input: BodyInput) {
  return (
    <PasswordSignInRequestBody
      client={{
        dispatch: (input.dispatch ?? vi.fn()) as unknown as PasswordSignInRequestClient["dispatch"],
      }}
      computerName="Mac mini"
      disabled={false}
      mac={input.mac ?? null}
      request={input.request ?? pending()}
      workspaceName="Main"
    />
  );
}

async function mountBody(input: BodyInput): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(body(input)));
  await act(async () => undefined);
  return container;
}

async function mountSurface(input: {
  readonly client?: MockHostClient;
  readonly desktopBridge?: Partial<OpensteerDesktopBridge>;
  readonly hostsDeploymentHere?: boolean;
  readonly localRunnerId?: string;
}): Promise<HTMLElement> {
  const client = input.client ?? new MockHostClient({ latencyMs: 0, pendingRequests: [pending()] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Outlet context={shellContext(client, input)} />}>
            <Route
              element={
                <InputSurface
                  disabled={false}
                  placeholder="Reply…"
                  requests={client.getSnapshot().requests[threadId] ?? []}
                  running={false}
                  threadId={threadId}
                />
              }
              index
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  client.subscribe(render);
  await act(async () => render());
  await act(async () => undefined);
  return container;
}

function shellContext(
  client: MockHostClient,
  input: {
    readonly desktopBridge?: Partial<OpensteerDesktopBridge>;
    readonly hostsDeploymentHere?: boolean;
    readonly localRunnerId?: string;
  },
): ShellContext {
  const origin = "http://127.0.0.1:60470";
  return {
    actionError: null,
    askOpensteerAbout: noOp,
    clearActionError: noOp,
    clearHomeHandoff: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: (input.desktopBridge ?? null) as OpensteerDesktopBridge | null,
    desktopDeployment: input.hostsDeploymentHere
      ? DesktopDeploymentSummarySchema.parse({
          access: "owner",
          activeOrigin: origin,
          canonicalOrigin: origin,
          id: createId("deployment"),
          kind: "personal",
          lastUsedAt: null,
          name: "Mac mini",
          onThisComputer: true,
          routes: [{ kind: "canonical", origin, selected: true }],
        })
      : null,
    executionPreferences: emptyExecutionPreferences,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
    hostClient: client,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus:
      input.localRunnerId === undefined
        ? null
        : ({
            runner: { runnerId: input.localRunnerId },
          } as unknown as NonNullable<ShellContext["localExecutionStatus"]>),
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    performLocalExecutionAction: async () => undefined,
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    setHomeDraft: noOp,
    snapshot: { ...client.getSnapshot(), connection: "connected" },
    writeInChat: noOp,
  };
}

function text(container: HTMLElement): string {
  return container.textContent ?? "";
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function buttonTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".sign-in-card .action-buttons button")].map(
    (candidate) => candidate.textContent ?? "",
  );
}

function radios(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLInputElement>(".account-choice input[type=radio]")].map(
    (input) => ({
      input,
      name: input.getAttribute("aria-label") ?? "",
      option: input.closest<HTMLElement>("label")!,
    }),
  );
}

/** The accessible name of the one group the accounts are in. */
function groupName(container: HTMLElement): string {
  const groups = [...container.querySelectorAll("fieldset[aria-labelledby]")];
  expect(groups).toHaveLength(1);
  const id = groups[0]!.getAttribute("aria-labelledby")!;
  return document.getElementById(id)?.textContent ?? "";
}

function describedBy(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function account(
  input: Partial<PasswordSignInAccount> & { readonly username: string },
): PasswordSignInAccount {
  return {
    host: "github.com",
    id: crypto.randomUUID(),
    label: null,
    onPage: true,
    revision: 1,
    updatedAt: "2026-01-15T12:00:00.000Z",
    ...input,
  };
}

/** The person's amazon.com logins as the broker sends them, page first. */
const amazon: readonly PasswordSignInAccount[] = [
  ...[
    "jordan3696@example.com",
    "morgan@example.com",
    "alex@company.example",
    "alex901@example.com",
  ].map((username) => account({ host: "www.amazon.com", username })),
  ...[
    ["portal.aws.amazon.com", "alex@example.com", "2025-08-10"],
    ["signin.aws.amazon.com", "alex@company.example", "2025-12-01"],
    ["signin.aws.amazon.com", "alex@example.com", "2026-03-14"],
    ["signin.aws.amazon.com", "alex@example.com", "2025-11-02"],
    ["signin.aws.amazon.com", "alex@example.com", "2025-06-20"],
    ["signin.aws.amazon.com", "alex@example.com", "2024-09-08"],
    ["us-east-1.signin.aws.amazon.com", "alex@example.com", "2025-02-17"],
  ].map(([host, username, day]) =>
    account({ host: host!, onPage: false, updatedAt: `${day}T12:00:00.000Z`, username: username! }),
  ),
];

/** Nine accounts on the page and amazon.com's seven others. */
const crowded: readonly PasswordSignInAccount[] = [
  ...amazon.slice(0, 4),
  ...["ana", "ben", "cy", "dee", "eli"].map((name) =>
    account({ host: "www.amazon.com", username: `${name}@example.com` }),
  ),
  ...amazon.slice(4),
];

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label}: ${buttonTexts(container).join(", ")}`);
  }
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function key(element: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: name }));
    await Promise.resolve();
  });
}

it("shows v5 app consent only for a Workspace operation", async () => {
  const request = pending();
  if (request.payload.kind !== "browser.password-sign-in") throw new Error("Wrong fixture");
  const { sessionId: _sessionId, ...payload } = request.payload;
  const modern = {
    ...request,
    payload: { ...payload, scope: "workspace", permissionVersion: 5 },
  } as Request;
  const mac = fakeMac({
    accounts: [alex],
    permissionVersion: 5,
    site: "https://github.com",
    stage: "approval",
  });
  const container = await mountBody({ mac: mac.bridge, request: modern });
  expect(container.textContent).toContain(
    "They can type it on this website and in apps they use, like on your phone.",
  );
  expect(container.textContent).toContain("a tricked agent could reveal it");
  expect(container.textContent).not.toContain("Sign-ins can stay saved in the browser profile");
});
