// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { MockTeamWorld } from "@opensteer/client/team";
import {
  click,
  goTo,
  history,
  mount,
  settle,
  typeInto,
} from "../components/workspace/workspace.interaction.test-support.js";

function button(name: string | RegExp, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    typeof name === "string"
      ? candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name
      : name.test(candidate.textContent ?? ""),
  );
  if (!match) throw new Error(`Missing button ${String(name)}`);
  return match;
}

function field(label: string): HTMLInputElement {
  const target = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = target ? document.getElementById(target.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing field ${label}`);
  return input;
}

function dialog(): HTMLElement {
  const open = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!open) throw new Error("No dialog is open");
  return open;
}

/** Waits on what the person would see, inside the test's deadline. */
async function until(done: () => boolean, what: string) {
  for (let step = 0; step < 100 && !done(); step++) await settle(20);
  if (!done()) throw new Error(`Never happened: ${what}`);
}

const here = () => history.at(-1)?.path ?? "";
const sampleInvite = (world: MockTeamWorld) => world.sampleInviteUrl;

async function createTeam(world: MockTeamWorld, name: string) {
  await mount("/teams", { world });
  await click(button("Create"));
  await typeInto(field("Team name"), name);
  await until(() => /is available/u.test(dialog().textContent ?? ""), "the address checked");
  await click(button("Create team"));
  await until(() => /\/teams\/dep_[^/]+\/c\//u.test(here()), "the team opened");
}

describe("hosted teams", () => {
  it("creates a team, refusing a taken address, and lands in #general as its owner", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await mount("/teams", { world });
    await click(button("Create"));
    await typeInto(field("Team name"), "Taken");
    await until(
      () => /Someone already uses that address/u.test(dialog().textContent ?? ""),
      "the taken address refused",
    );
    expect(button("Create team").disabled).toBe(true);
    await typeInto(field("Team name"), "Acme");
    await until(
      () => /acme\.teams\.opensteer\.com is available/u.test(dialog().textContent ?? ""),
      "acme available",
    );
    await click(button("Create team"));
    await until(() => /\/teams\/dep_[^/]+\/c\//u.test(here()), "the team opened");
    await until(() => document.querySelector(".teams-welcome") !== null, "the welcome card");
    const welcome = document.querySelector(".teams-welcome")!.textContent ?? "";
    expect(welcome).toContain("Acme is ready");
    expect(welcome).toContain("You’re the owner.");
    expect(welcome).toContain("Your agent is connected.");
    expect(world.joined()[0]?.bootstrap.member.role).toBe("owner");
  });

  it("joins with an invite after one confirmation and lands as a member", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await mount("/teams", { world });
    await typeInto(field("Invite link"), sampleInvite(world));
    await click(button("Join"));
    await until(() => /Join Northwind/u.test(dialog().textContent ?? ""), "the join confirmation");
    expect(dialog().textContent).toContain("You’ll join as you@example.com.");
    await click(button("Join Northwind"));
    await until(() => document.querySelector(".teams-welcome") !== null, "the welcome card");
    const welcome = document.querySelector(".teams-welcome")!.textContent ?? "";
    expect(welcome).toContain("Welcome to Northwind");
    expect(welcome).toContain("You joined as a member.");
    expect(document.querySelector(".team-side__invite")).toBeNull();
  });

  it("shows the team's invite and Reset replaces the link", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await createTeam(world, "Acme");
    await until(() => document.querySelector(".teams-welcome") !== null, "the welcome card");
    await click(button("Invite people", document.querySelector(".teams-welcome")!));
    await until(() => field("Invite link").value.startsWith("https://acme."), "the invite link");
    const first = field("Invite link").value;
    expect(dialog().querySelector('svg[aria-label="QR code for the invite link"]')).not.toBeNull();
    await click(button(/Reset link/u));
    await until(() => field("Invite link").value !== first, "a new link");
    expect(field("Invite link").value).toMatch(/^https:\/\/acme\.teams\.opensteer\.com\/invite\//u);
  });

  it("makes one-person invites on a team server older than reusable invites", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await createTeam(world, "Acme");
    await until(() => document.querySelector(".teams-welcome") !== null, "the welcome card");
    const host = world.joined()[0]!;
    const read = host.read.bind(host);
    vi.spyOn(host, "read").mockImplementation(async (name, input) => {
      if (name === "team.invite.current.get")
        throw new OpensteerError({ code: "not_found", message: "Unknown read" });
      return read(name, input);
    });
    await click(button("Invite people", document.querySelector(".teams-welcome")!));
    await until(
      () => /Each link lets one person join/u.test(dialog().textContent ?? ""),
      "the older-server sheet",
    );
    await click(button("Make an invite link"));
    await until(() => field("Invite link").value.startsWith("https://"), "a one-person link");
    expect([...host.invites.values()]).toMatchObject([{ maxUses: 1 }]);
    expect(dialog().textContent).not.toMatch(/Reset link/u);
  });

  it("offers Try again, not one-person links, when the team can't be reached", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await createTeam(world, "Acme");
    await until(() => document.querySelector(".teams-welcome") !== null, "the welcome card");
    const host = world.joined()[0]!;
    const read = host.read.bind(host);
    let reachable = false;
    vi.spyOn(host, "read").mockImplementation(async (name, input) => {
      if (name === "team.invite.current.get" && !reachable)
        throw new OpensteerError({ code: "timeout", message: "The team isn’t reachable." });
      return read(name, input);
    });
    await click(button("Invite people", document.querySelector(".teams-welcome")!));
    await until(() => button("Try again", dialog()) !== undefined, "the retry");
    expect(dialog().textContent).not.toMatch(/Each link lets one person join/u);
    reachable = true;
    await click(button("Try again", dialog()));
    await until(() => field("Invite link").value.startsWith("https://acme."), "the invite link");
  });

  it("disconnects only the agent, and deletes the team once its name is typed", async () => {
    const world = new MockTeamWorld({ pace: 0 });
    await createTeam(world, "Acme");
    const teamId = /\/teams\/(dep_[^/]+)\//u.exec(here())![1]!;
    await act(async () => void goTo!(`/settings/teams/${teamId}/profile`));
    await until(
      () => /Your agent is connected/u.test(document.body.textContent ?? ""),
      "the profile",
    );
    await click(button("Disconnect"));
    await until(
      () => /Your agent isn’t connected/u.test(document.body.textContent ?? ""),
      "disconnected",
    );
    expect(world.joined()).toHaveLength(1);

    await click(button("Delete"));
    const confirm = button("Delete Acme", dialog());
    expect(confirm.disabled).toBe(true);
    await typeInto(field("Type Acme to confirm"), "Acme");
    await click(confirm);
    await until(() => here() === "/", "home after deleting");
    expect(world.joined()).toEqual([]);
    expect(await world.account.listHostedTeams()).toEqual([]);
  });
});
