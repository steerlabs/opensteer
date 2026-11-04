import {
  browserAccessChoices,
  browserAccessInitialSelection,
  type BrowserAccessChoices,
  type BrowserAccessSelection,
  type BrowserProfileSummary,
  type HostSnapshot,
} from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserAccessBody } from "./thread-browser-access-action.js";

const personalId = createId("browserProfile");
const workId = createId("browserProfile");
const profiles: BrowserProfileSummary[] = [
  { id: personalId, name: "Personal" },
  { id: workId, name: "Work" },
];
const mainId = createId("workspace");
const projectId = createId("workspace");
const snapshot = {
  browserProfiles: profiles,
  browserProfileGrants: [
    {
      access: "read-write",
      createdAt: "2026-11-04T00:00:00.000Z",
      id: createId("browserProfileGrant"),
      profileId: workId,
      workspaceId: projectId,
    },
  ],
  workspaces: [
    { id: mainId, kind: "main", name: "Main" },
    { id: projectId, kind: "project", name: "Client" },
  ],
} as unknown as Pick<HostSnapshot, "browserProfileGrants" | "browserProfiles" | "workspaces">;
const project = browserAccessChoices(snapshot, projectId);
const main = browserAccessChoices(snapshot, mainId);

function render(
  choices: BrowserAccessChoices,
  selection: BrowserAccessSelection | null,
  name = selection?.kind === "new" ? "Portal" : "",
): string {
  return renderToStaticMarkup(
    <BrowserAccessBody
      choices={choices}
      name={name}
      onChangeName={vi.fn()}
      onDecline={vi.fn()}
      onGrant={vi.fn()}
      onSelect={vi.fn()}
      pending={false}
      selection={selection}
    />,
  );
}

describe("browserAccessInitialSelection", () => {
  it("pre-selects the suggested profile only when the owner still has it", () => {
    expect(
      browserAccessInitialSelection({ kind: "existing", profileId: workId }, profiles),
    ).toEqual({ kind: "existing", profileId: workId });
    expect(
      browserAccessInitialSelection(
        { kind: "existing", profileId: createId("browserProfile") },
        profiles,
      ),
    ).toBeNull();
  });

  it("pre-selects a new profile for a new suggestion and nothing for user choice", () => {
    expect(
      browserAccessInitialSelection({ kind: "new", suggestedName: "Portal" }, profiles),
    ).toEqual({ kind: "new" });
    expect(browserAccessInitialSelection({ kind: "user_choice" }, profiles)).toBeNull();
  });
});

describe("BrowserAccessBody", () => {
  it("keeps the grant unavailable until the owner chooses for a user-choice suggestion", () => {
    const markup = render(
      project,
      browserAccessInitialSelection({ kind: "user_choice" }, profiles),
    );

    expect(markup).not.toContain('checked=""');
    expect(markup).not.toContain(">Name<");
    expect(markup).toContain('disabled="" type="button">Allow full control');
  });

  it("marks a Project's usable profiles and creates and allows a new one", () => {
    expect(render(project, { kind: "existing", profileId: workId })).toContain(
      "Already available to Client",
    );
    expect(render(project, { kind: "existing", profileId: workId })).toContain(">Use profile<");
    expect(render(project, { kind: "new" })).toContain(">Create and allow<");
  });

  it("in Main, uses any profile as is and creates a new one without a grant", () => {
    const existing = render(main, { kind: "existing", profileId: personalId });
    expect(existing).not.toContain("Already available");
    expect(existing).toContain(">Use profile<");
    expect(existing).toContain("Agents in Main can use every browser profile you have");
    expect(render(main, { kind: "new" })).toContain(">Create profile<");
  });

  it("suggests only names the owner has not used, and marks the one chosen", () => {
    expect(main.nameSuggestions).toEqual(["Finance", "Shopping"]);
    const markup = render(main, { kind: "new" }, "Finance");
    expect(markup).toContain('aria-pressed="true" class="chip chip--accent"');
    expect(markup).toContain(">Shopping<");
    expect(markup).not.toContain(">Personal</button>");
  });
});
