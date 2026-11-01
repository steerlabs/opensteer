import {
  browserAccessInitialSelection,
  type BrowserAccessSelection,
  type BrowserProfileSummary,
} from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserAccessBody, type BrowserAccessView } from "./thread-browser-access-action.js";

const personalId = createId("browserProfile");
const workId = createId("browserProfile");
const profiles: BrowserProfileSummary[] = [
  { id: personalId, name: "Personal" },
  { id: workId, name: "Work" },
];
const pendingView: BrowserAccessView = {
  kind: "pending",
  profiles,
  grantedProfileIds: [],
  workspaceName: "Client",
};

function render(
  view: BrowserAccessView,
  selection: BrowserAccessSelection | null,
  name = selection?.kind === "new" ? "Portal" : "",
): string {
  return renderToStaticMarkup(
    <BrowserAccessBody
      name={name}
      onChangeName={vi.fn()}
      onDecline={vi.fn()}
      onGrant={vi.fn()}
      onSelect={vi.fn()}
      pending={false}
      selection={selection}
      view={view}
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
      pendingView,
      browserAccessInitialSelection({ kind: "user_choice" }, profiles),
    );

    expect(markup).not.toContain('checked=""');
    expect(markup).not.toContain("Profile name");
    expect(markup).toContain('disabled="" type="button">Allow full control');
  });
});
