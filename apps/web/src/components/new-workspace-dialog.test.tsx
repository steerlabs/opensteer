// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "@opensteer/client/host";
import { NewWorkspaceDialog } from "./new-workspace-dialog.js";

const noOp = () => undefined;

function machine(overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary {
  return {
    capabilities: [],
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessCatalogs: [],
    harnessDrivers: [],
    id: "env_11111111-1111-4111-8111-111111111111",
    kind: "local",
    name: "Laptop",
    providerStateModes: ["isolated"],
    runnerId: "rnr_11111111-1111-4111-8111-111111111111",
    status: "connected",
    workspaceBackings: ["local-directory"],
    ...overrides,
  };
}

function render(
  environments: readonly EnvironmentSummary[],
  sharedStorageAvailable = true,
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewWorkspaceDialog
        creating={false}
        defaultBacking="local-directory"
        environments={environments}
        error={null}
        onClose={noOp}
        onCreate={noOp}
        sharedStorageAvailable={sharedStorageAvailable}
      />
    </MemoryRouter>,
  );
}

describe("NewWorkspaceDialog", () => {
  it("requires a new choice when the selected computer disconnects", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onCreate = vi.fn();
    const selected = machine();
    const other = machine({ id: "env_bbbbbbbb-2222-4222-8222-000000000002", name: "Other" });
    const update = async (environments: readonly EnvironmentSummary[]) => {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <NewWorkspaceDialog
              creating={false}
              defaultBacking="local-directory"
              environments={environments}
              error={null}
              onClose={noOp}
              onCreate={onCreate}
              sharedStorageAvailable={false}
            />
          </MemoryRouter>,
        ),
      );
    };
    try {
      await update([selected, other]);
      const name = container.querySelector("input");
      if (!name) throw new Error("Missing name input");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          name,
          "Research",
        );
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        false,
      );
      await update([{ ...selected, connected: false }, other]);
      const select = container.querySelector("select");
      expect(select?.value).toBe(selected.id);
      const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(submit?.disabled).toBe(true);
      await act(async () =>
        container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(onCreate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("tells two computers with the same name apart", () => {
    const html = render([
      machine({ id: "env_aaaaaaaa-1111-4111-8111-00000000abcd", name: "Laptop" }),
      machine({ id: "env_bbbbbbbb-2222-4222-8222-00000000ef01", name: "Laptop" }),
      machine({ id: "env_cccccccc-3333-4333-8333-000000002345", name: "Office Mac" }),
    ]);

    expect(html).toContain("Laptop · 00abcd");
    expect(html).toContain("Laptop · 00ef01");
    // A name nothing collides with stays the name the person gave it.
    expect(html).toContain(">Office Mac<");
    expect(html).not.toContain("Office Mac ·");
  });

  it("refuses an offline computer instead of letting the Host reject it", () => {
    const html = render(
      [
        machine({ connected: true, id: "env_aaaaaaaa-1111-4111-8111-000000000001", name: "Mac" }),
        machine({
          connected: false,
          id: "env_bbbbbbbb-2222-4222-8222-000000000002",
          name: "Linux box",
          status: "disconnected",
        }),
      ],
      false,
    );

    expect(html).toContain('<option disabled="" value="env_bbbbbbbb-2222-4222-8222-000000000002"');
    expect(html).toContain('<option value="env_aaaaaaaa-1111-4111-8111-000000000001" selected=""');
    expect(html).toContain("An offline computer cannot be chosen");
    expect(html).not.toContain("created once it reconnects");
    // The one online computer still makes the form usable.
    expect(html).toContain("Create specialist");
  });
});
