// @vitest-environment happy-dom

import type {
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerAppPicker } from "./computer-app-picker.js";

const macMini = "rnr_11111111-1111-4111-8111-111111111111";
const macBook = "rnr_33333333-3333-4333-8333-333333333333";
const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
});

describe("ComputerAppPicker", () => {
  it("requests setup at the safe level unless the person picks the other one", async () => {
    const onTurnOn = vi.fn();
    const { container } = await mount({
      connections: [],
      machines: [machine(macBook, "Alex's MacBook Pro")],
      onTurnOn,
    });

    await click(button(container, "Request setup on Alex's MacBook Pro"));
    expect(onTurnOn).toHaveBeenLastCalledWith({ access: "read", runnerId: macBook });

    await click(radio(container, "Read and send"));
    await click(button(container, "Request setup on Alex's MacBook Pro"));
    expect(onTurnOn).toHaveBeenLastCalledWith({ access: "read-write", runnerId: macBook });
  });

  it("keeps macOS setup separate from the selected agent access", async () => {
    const onTurnOn = vi.fn();
    const blocked = machine(macBook, "Alex's MacBook Pro");
    const { container } = await mount({
      connections: [],
      machines: [
        {
          ...blocked,
          apps: [
            {
              definitionId: "apple-messages",
              operations: [
                {
                  detail: "Full Disk Access is required.",
                  operation: "list_conversations",
                  remedy: "full-disk-access",
                  state: "permission-required",
                },
              ],
            },
          ],
        },
      ],
      onTurnOn,
    });

    expect(container.textContent).toContain("Reading Messages needs macOS Full Disk Access");
    expect(container.textContent).toContain("Review setup");
    expect(
      container.querySelector(
        `a[href="/settings/computers/${macBook}#computer-app-apple-messages"]`,
      ),
    ).not.toBeNull();
    expect(radio(container, "Read only").getAttribute("aria-checked")).toBe("true");

    await click(button(container, "Request setup on Alex's MacBook Pro"));
    expect(onTurnOn).toHaveBeenCalledWith({ access: "read", runnerId: macBook });
  });

  it("sends an iPhone's setup to iPhone Settings rather than macOS", async () => {
    const iphone = "rnr_22222222-2222-4222-8222-222222222222";
    const detail = "Calendar needs full access for Opensteer in iPhone Settings.";
    const { container } = await mount({
      connections: [],
      definition: calendar(),
      machines: [
        {
          ...machine(iphone, "Alex's iPhone"),
          apps: [
            {
              definitionId: "apple-calendar",
              operations: [
                {
                  detail,
                  operation: "list_events",
                  remedy: "calendars",
                  state: "permission-required",
                },
              ],
            },
          ],
          device: { form: "phone", platform: "ios" },
        },
      ],
    });

    expect(container.textContent).toContain("Calendar needs access on Alex's iPhone");
    expect(container.textContent).toContain(
      `${detail} Allow it in iPhone Settings on Alex's iPhone. It does not change the agent access selected for this app.`,
    );
    expect(container.textContent).not.toContain("macOS Calendars access");
    expect(container.textContent).not.toContain("Opensteer Computer Use");
    // The row's own status is the iPhone's sentence, never a macOS label.
    expect(container.querySelector(".computer-apps__status")?.textContent).toBe(detail);
    expect(container.textContent).not.toContain("macOS");
  });

  it("does not silently retarget after the chosen computer stops offering the app", async () => {
    const onTurnOn = vi.fn();
    const mounted = await mount({
      connections: [],
      machines: [machine(macMini, "Mac mini"), machine(macBook, "Alex's MacBook Pro")],
      onTurnOn,
    });

    await click(machineChoice(mounted.container, "Alex's MacBook Pro"));
    await mounted.render({
      connections: [],
      machines: [machine(macMini, "Mac mini")],
      onTurnOn,
    });

    expect(mounted.container.textContent).not.toContain("Request setup on Mac mini");
    expect(onTurnOn).not.toHaveBeenCalled();
  });
});

function machineChoice(container: HTMLElement, label: string): HTMLInputElement {
  const found = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (candidate) => candidate.closest("label")?.textContent?.includes(label),
  );
  if (!found) throw new Error(`Missing computer choice: ${label}`);
  return found;
}

function radio(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing access option: ${label}`);
  return found;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function mount(input: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition?: IntegrationDefinitionSummary;
  readonly machines: readonly MachineSummary[];
  readonly onTurnOn?: (input: { readonly access: string; readonly runnerId: string }) => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const render = async (next: typeof input): Promise<void> => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ComputerAppPicker
            busy={false}
            connections={next.connections}
            definition={next.definition ?? messages()}
            machines={next.machines}
            onTurnOn={next.onTurnOn ?? (() => undefined)}
          />
        </MemoryRouter>,
      );
    });
  };
  await render(input);
  return { container, render };
}

function messages(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      accessSummaries: {
        read: "Agents can search and read your conversations.",
        readWrite: "Agents can search and read your conversations, and send messages as you.",
      },
      operations: [
        { effect: "read", name: "list_conversations" },
        { effect: "write", name: "send_message" },
      ],
      platforms: ["darwin"],
    },
    description: "Search, read, and send Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  } as unknown as IntegrationDefinitionSummary;
}

function calendar(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    apiKey: null,
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "Allows reading calendars.", readWrite: "Allows changing them." },
      operations: [
        { effect: "read", name: "list_events" },
        { effect: "write", name: "create_event" },
      ],
      platforms: ["darwin"],
    },
    description: "Read and change Calendar through an enrolled Mac.",
    id: "apple-calendar",
    name: "Calendar",
    provider: "apple-calendar",
  };
}

function machine(id: string, name: string): MachineSummary {
  return {
    access: null,
    allowedModules: ["integrations", "shell"],
    apps: [
      {
        definitionId: "apple-messages",
        operations: [
          {
            detail: "Ready to read",
            operation: "list_conversations",
            remedy: null,
            state: "ready",
          },
          {
            detail: null,
            operation: "send_message",
            remedy: null,
            state: "ready",
          },
        ],
      },
    ],
    detail: null,
    enrollmentId: null,
    expiresAt: null,
    fullDiskAccess: false,
    id,
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: {},
    name,
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    unlinkedLocalFolders: 0,
  } as MachineSummary;
}
