// @vitest-environment happy-dom
import { MemoryRouter } from "react-router";
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";
import { ChannelDashboardSchema, createChannelId } from "@opensteer/channel-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./toast.js";
import { MessagingPage } from "./messaging-page.js";

const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const shell = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./app-shell.js", () => ({ useShell: () => shell.value }));

async function mount(client: MockHostClient, at = "/settings/messaging") {
  shell.value = { hostClient: client, snapshot: client.getSnapshot() };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <ToastProvider>
          <MessagingPage embedded />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

function chats(scene: "chats" | "chats-empty" | "chats-unreadable" = "chats") {
  return new MockHostClient({ latencyMs: 0, ...mockConnectedAgents(scene) });
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The mock’s messaging settings changed by `edit`; every read after the first `failAfter` fails. */
async function withDashboard(
  client: MockHostClient,
  edit: (dashboard: ReturnType<typeof ChannelDashboardSchema.parse>) => unknown,
  failAfter = Number.POSITIVE_INFINITY,
) {
  const loaded = unwrapRpcResult(await client.rpc["channels.get"]({}));
  const dashboard = ChannelDashboardSchema.parse(edit(ChannelDashboardSchema.parse(loaded)));
  let reads = 0;
  const rpc = client.rpc;
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "channels.get"
          ? async () => {
              reads += 1;
              if (reads > failAfter) throw new Error("offline");
              return { ok: true, data: dashboard };
            }
          : Reflect.get(target, key),
    }),
  });
  return dashboard;
}

describe("Messaging", () => {
  it("shows each account's state, what becomes of messages sent while it is paused, who is me, and its chats", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      const text = page.textContent ?? "";
      // Paused iMessage: messages sent meanwhile arrive when it is back.
      expect(text).toContain(
        "Paused: its chats hold their replies until you resume it. Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late.",
      );
      // Needs attention: what it reports, and Fix setup; never a promise it is live.
      expect(text).toContain("Needs attention");
      expect(text).toContain("Slack says the token was revoked.");
      expect(button(page, "Fix setup")).toBeTruthy();
      // Who me is, and how to change it.
      expect(text).toContain("Tim is you. Messages from it count as you in your chats.");
      expect(text).toContain("Linking another account replaces Tim as you.");
      // Its chats, each a connected agent with the line the list shows.
      await vi.waitFor(() => expect(text.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(page.textContent).toContain("Slack · #team"));
      expect(page.textContent).toContain("#team on Slack, through Workshop · Tasks · Supervised");
      const link = [...page.querySelectorAll("a")].find((a) => a.textContent === "Slack · #team");
      expect(link?.getAttribute("href")).toBe(
        "/settings/external-agents/mcn_00000000-0000-4000-8000-0000000000c2",
      );
      expect(page.textContent).not.toMatch(/bridge|lineage|ingress|route|binding|waiting/iu);
    } finally {
      client.dispose();
    }
  });

  it("says a paused Slack account's messages are not delivered", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      const toggle = page.querySelector<HTMLInputElement>('input[aria-label="Pause Workshop"]');
      expect(toggle).not.toBeNull();
      await act(async () => toggle!.click());
      await vi.waitFor(() =>
        expect(page.textContent).toContain(
          "Paused: its chats hold their replies until you resume it. Messages sent while this is paused are not delivered.",
        ),
      );
    } finally {
      client.dispose();
    }
  });

  it("shows the code that links me: what to send, from which account, and until when", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("On-call"));
      const dispatch = vi.spyOn(client, "dispatch");
      const links = [...page.querySelectorAll("button")].filter(
        (b) => b.textContent === "Link another account" || b.textContent === "Link my account",
      );
      await act(async () => links[0]!.click());
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "channel.me.link" }));
      await vi.waitFor(() =>
        expect(page.textContent).toMatch(
          /Send MOCKCODE to Workshop in a direct message from your own Slack account\. It works once, until .+\. Nothing is said in the chat; this page shows your account once it’s linked\./u,
        ),
      );
    } finally {
      client.dispose();
    }
  });

  it("adds a chat for one channel: who may give it work is chosen once, and says so", async () => {
    const client = chats("chats-empty");
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      expect(page.textContent).toContain("No chat on this account yet.");
      await act(async () =>
        [...page.querySelectorAll("button")].find((b) => b.textContent === "Add a chat")!.click(),
      );
      expect(page.textContent).toContain(
        "This can’t be changed later; to change it, disconnect the chat and add it again.",
      );
      const channelChoice = [...page.querySelectorAll("label")].find(
        (label) => label.textContent === "One channel",
      );
      await act(async () => channelChoice!.querySelector("input")!.click());
      const [id, name] = [
        ...page.querySelectorAll<HTMLInputElement>(".messaging-add-chat input.text-input"),
      ];
      await type(id!, "C-TEAM");
      await type(name!, "team");
      const anyone = [...page.querySelectorAll("label")].find((label) =>
        label.textContent?.startsWith("Anyone in the channel"),
      );
      expect(anyone?.textContent).toContain(
        "Anyone who can write there can give this agent work. Tasks they start run without your personal context.",
      );
      await act(async () => anyone!.querySelector("input")!.click());
      const dispatch = vi.spyOn(client, "dispatch");
      await act(async () => button(page, "Add chat").click());
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "channel.chat.create",
          conversation: { id: "C-TEAM", name: "#team" },
          senders: "anyone",
          grant: { scope: "selected", tasks: true, resources: [] },
        }),
      );
      await vi.waitFor(() => expect(page.textContent).toContain("Slack · #team"));
    } finally {
      client.dispose();
    }
  });

  it("asks before removing an account, and says what ends", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      const menu = page.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Workshop"]',
      );
      await act(async () => menu!.click());
      const dispatch = vi.spyOn(client, "dispatch");
      await act(async () =>
        [...document.querySelectorAll<HTMLElement>("[role=menuitem], button")]
          .find((item) => item.textContent?.includes("Remove account"))!
          .click(),
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Every chat on it ends, and nothing sent there gives your own agents work again.",
      );
    } finally {
      client.dispose();
    }
  });

  it("says a failed read failed: no account shown as connected or gone", async () => {
    const client = chats();
    try {
      const rpc = client.rpc;
      Object.defineProperty(client, "rpc", {
        value: new Proxy(rpc, {
          get: (target, key) =>
            key === "channels.get"
              ? async () => {
                  throw new Error("offline");
                }
              : Reflect.get(target, key),
        }),
      });
      const page = await mount(client);
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Couldn’t read your messaging accounts."),
      );
      expect(page.textContent).not.toContain("Workshop");
      expect(page.textContent).not.toContain("No messaging account yet");
    } finally {
      client.dispose();
    }
  });

  it("previews a Home that can't be read as could not read, never as no account", async () => {
    const client = chats("chats-unreadable");
    try {
      const page = await mount(client);
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Couldn’t read your messaging accounts."),
      );
      expect(page.textContent).not.toContain("No messaging account yet");
      expect(page.textContent).not.toContain("Workshop");
      // Its first read failed too: Try again reads again.
      const read = vi.fn();
      const rpc = client.rpc;
      Object.defineProperty(client, "rpc", {
        value: new Proxy(rpc, {
          get: (target, key) => {
            if (key === "channels.get") read();
            return Reflect.get(target, key);
          },
        }),
      });
      await act(async () => button(page, "Try again").click());
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
    } finally {
      client.dispose();
    }
  });

  it("says an account's chats could not be read when that read failed, never that it has none", async () => {
    const client = chats();
    try {
      Object.defineProperty(client.rpc, "connections.list", {
        value: vi.fn(async () => {
          throw new Error("down");
        }),
        configurable: true,
      });
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Couldn’t read this account’s chats."),
      );
      expect(page.textContent).not.toContain("No chat on this account yet.");
    } finally {
      client.dispose();
    }
  });

  it("offers no Pause switch for an account that needs attention: only Check again", async () => {
    const client = chats();
    try {
      await withDashboard(client, (dashboard) => ({
        ...dashboard,
        connections: dashboard.connections.map((connection) =>
          connection.transportKind === "computer"
            ? { ...connection, status: "needs-attention", statusDetail: "The Mac is offline." }
            : connection,
        ),
      }));
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("The Mac is offline."));
      expect(page.querySelector('input[aria-label="Pause Messages on Studio Mac"]')).toBeNull();
      expect(page.querySelector('input[aria-label="Resume Messages on Studio Mac"]')).toBeNull();
      expect(
        page.querySelector('button[aria-label="Actions for Messages on Studio Mac"]'),
      ).not.toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("offers a chat in one channel only where the provider says it has channels", async () => {
    const client = chats("chats-empty");
    try {
      await withDashboard(client, (dashboard) => ({
        ...dashboard,
        providers: dashboard.providers.map((provider) => ({ ...provider, channelChats: false })),
      }));
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      await act(async () =>
        [...page.querySelectorAll("button")].find((b) => b.textContent === "Add a chat")!.click(),
      );
      expect(
        [...page.querySelectorAll("label")].some((label) => label.textContent === "One channel"),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it("after a read that failed, no account still reads as Connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = chats();
    try {
      await withDashboard(client, (dashboard) => dashboard, 1);
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      expect(page.textContent).toContain("Connected");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Couldn’t read your messaging accounts."),
      );
      const chips = [...page.querySelectorAll(".chip")].map((chip) => chip.textContent);
      expect(chips).not.toContain("Connected");
      expect(chips).toContain("Not read just now");
      expect(button(page, "Try again")).toBeTruthy();
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("says a code shown on a paused account links it only once the account is resumed", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Messages on Studio Mac"));
      const links = [...page.querySelectorAll("button")].filter(
        (b) => b.textContent === "Link another account" || b.textContent === "Link my account",
      );
      await act(async () => links[1]!.click());
      await vi.waitFor(() => expect(page.textContent).toContain("Send MOCKCODE to"));
      expect(page.textContent).toContain(
        "Once this account is resumed, sending the code links your account.",
      );
    } finally {
      client.dispose();
    }
  });

  it("says a code shown on an account that needs attention links it only once it is fixed", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("On-call"));
      const links = [...page.querySelectorAll("button")].filter(
        (b) => b.textContent === "Link another account" || b.textContent === "Link my account",
      );
      await act(async () => links[2]!.click());
      await vi.waitFor(() => expect(page.textContent).toContain("Send MOCKCODE to On-call"));
      expect(page.textContent).toContain(
        "Until this account is fixed, the code can’t link your account: fix its setup first, then send it.",
      );
    } finally {
      client.dispose();
    }
  });

  it("says the Home's own sentence when it refuses a chat: another chat already answers there", async () => {
    const client = chats();
    try {
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      // Workshop's direct messages already have a chat.
      await act(async () =>
        [...page.querySelectorAll("button")].find((b) => b.textContent === "Add a chat")!.click(),
      );
      await act(async () => button(page, "Add chat").click());
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Another chat already answers in this conversation."),
      );
      expect(page.textContent).not.toContain("Couldn't change messaging settings.");
    } finally {
      client.dispose();
    }
  });

  it("after a read that failed, offers nothing that changes anything: only Try again and moving around", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = chats();
    try {
      await withDashboard(client, (dashboard) => dashboard, 1);
      const page = await mount(client);
      await vi.waitFor(() => expect(page.textContent).toContain("Workshop"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await vi.waitFor(() => expect(page.textContent).toContain("Not read just now"));
      // Every control that sends a command, found by enumeration, not by name.
      const live = [
        ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          "button, input, [role=switch], [role=menuitem]",
        ),
      ].filter(
        (control) =>
          !(control as HTMLButtonElement).disabled &&
          !control.closest("fieldset[disabled]") &&
          control.textContent !== "Try again",
      );
      expect(
        live.map((control) => control.textContent || control.getAttribute("aria-label")),
      ).toEqual([]);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("selects only the Messaging account named by the child route", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const loaded = unwrapRpcResult(await client.rpc["channels.get"]({}));
    const dashboard = ChannelDashboardSchema.parse({
      ...loaded,
      connections: ["Support channel", "Team channel"].map((displayName) => ({
        capabilities: [],
        connectionMethod: "api-key",
        createdAt: "2026-01-01T00:00:00.000Z",
        displayName,
        externalIdentityId: null,
        externalTenantId: null,
        id: createChannelId("connection"),
        ownerUserId: client.getSnapshot().user!.id,
        provider: "slack",
        status: "connected",
        statusDetail: null,
        statusReason: null,
        transportKind: "socket",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    const rpc = client.rpc;
    Object.defineProperty(client, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key) =>
          key === "channels.get"
            ? async () => ({ ok: true, data: dashboard })
            : Reflect.get(target, key),
      }),
    });
    const selected = dashboard.connections[0]!;
    const other = dashboard.connections[1]!;
    try {
      const page = await mount(client, `/settings/messaging/${selected.id}`);
      await vi.waitFor(() => expect(page.textContent).toContain(selected.displayName));
      expect(page.textContent).not.toContain(other.displayName);
      expect(page.querySelector('a[href="/settings/messaging"]')).not.toBeNull();
    } finally {
      client.dispose();
    }
  });
});
