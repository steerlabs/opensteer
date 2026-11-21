import { browserSiteDomain } from "@opensteer/browser-source-wire/site";
import {
  StatusSchema,
  askWorker,
  type ConnectionState,
  type ConnectionView,
  type Status,
  type TabShareProblemCode,
  type UiRequest,
} from "./messages.js";
import { liveTabsOnly } from "./variant.js";
import { h, hostOf, icon, relativeTime, requireElement } from "./ui.js";

const root = requireElement<HTMLElement>("#popup");
let current: Status | null = null;
let confirming: string | null = null;
let problem: string | null = null;
let lastRendered = "";

const stateLabels: Record<ConnectionState, { label: string; tone: string }> = {
  "different-opensteer": { label: "Connect again", tone: "warn" },
  connected: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting…", tone: "wait" },
  ended: { label: "Disconnected by Opensteer", tone: "bad" },
  offline: { label: "Offline — Chrome keeps trying", tone: "idle" },
  "route-changed": { label: "Reconnect needed", tone: "warn" },
  "update-required": { label: "Extension update needed", tone: "warn" },
  "host-outdated": { label: "Opensteer update needed", tone: "warn" },
};

const tabShareProblems: Record<TabShareProblemCode, string> = {
  "untrusted-request": "Open the Opensteer tab sharing toolbar button to share this tab.",
  "invalid-request": "Chrome couldn’t read this share request. Open the toolbar button again.",
  "worker-unavailable": "Opensteer tab sharing couldn’t answer. Open the toolbar button again.",
  "invalid-response": "Opensteer tab sharing couldn’t confirm whether the tab was shared.",
  unsupported: "Use the Opensteer tab sharing extension to share this tab.",
  "home-offline": "This Home is offline in Chrome. Wait until it’s available to share the tab.",
  "tab-unavailable": "Chrome couldn’t find the tab to share.",
  "unsupported-page": "Chrome doesn’t allow sharing this page.",
  "shared-elsewhere": "This tab is shared with another Home. Stop sharing it there first.",
  "detach-unconfirmed":
    "Chrome couldn’t confirm that the previous debugger detached. Close and reopen the tab before sharing it again.",
  capacity: "Too many Chrome tabs are shared. Stop sharing a tab and try again.",
  "target-unavailable": "Chrome couldn’t open this tab for sharing. Reload the tab and try again.",
  unexpected: "Chrome couldn’t share the tab. Check whether it appears under Shared Chrome tabs.",
};

function settingsUrl(connection: ConnectionView): string {
  return new URL("/settings/chrome", connection.origin).href;
}

async function openOpensteer(connection: ConnectionView): Promise<void> {
  await chrome.tabs.create({ url: settingsUrl(connection) });
  window.close();
}

async function act(request: UiRequest): Promise<void> {
  root.setAttribute("aria-busy", "true");
  const result = await askWorker(request, StatusSchema);
  root.setAttribute("aria-busy", "false");
  if (result.ok) {
    current = result.value;
    problem = null;
  } else {
    problem = result.tabShareReason
      ? tabShareProblems[result.tabShareReason]
      : "Chrome couldn't make that change. Try again.";
  }
  render(true);
}

function button(
  classes: string,
  label: string,
  onClick: () => void,
  attributes: Record<string, string> = {},
  glyph?: Parameters<typeof icon>[0],
): HTMLButtonElement {
  const element = h(`button.${classes}` as "button", { type: "button", ...attributes });
  if (glyph) element.append(icon(glyph));
  element.append(label);
  element.addEventListener("click", onClick);
  return element;
}

function statusLabel(state: ConnectionState): HTMLElement {
  const { label, tone } = stateLabels[state];
  return h(
    "span.status",
    { "data-tone": tone, role: "status" },
    h("span.status__dot", { "aria-hidden": "true" }),
    label,
  );
}

function fix(connection: ConnectionView): HTMLElement | null {
  const name = connection.deploymentName;
  const key = connection.sourceId;
  switch (connection.state) {
    case "connected":
    case "connecting":
      return null;
    case "offline":
      return h(
        "div.notice",
        {},
        icon("globe"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `Chrome can't reach ${name}. Make sure Opensteer is running on that computer.`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small",
              "Try now",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
              "reload",
            ),
          ),
        ),
      );
    case "update-required":
      return h(
        "div.notice.notice--warn",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `Update the Opensteer extension: download it from ${name}, replace the folder you installed, then choose Reload on Opensteer in chrome://extensions.`,
          ),
          h(
            "div.notice__actions",
            {},
            h(
              "a.btn.btn--small.btn--primary",
              {
                href: new URL(
                  liveTabsOnly ? "/browser-live-tabs-extension.zip" : "/browser-extension.zip",
                  connection.origin,
                ).href,
                target: "_blank",
                "data-key": `download:${key}`,
              },
              icon("download"),
              "Download update",
            ),
            button(
              "btn.btn--small.btn--ghost",
              "Try again",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
            ),
          ),
        ),
      );
    case "host-outdated":
      // Downloading from an older Opensteer would install an older extension.
      return h(
        "div.notice.notice--warn",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `This Opensteer needs an update before Chrome can connect. Update Opensteer on the computer that runs ${name}; this reconnects by itself once it has.`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small",
              "Try again",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
              "reload",
            ),
          ),
        ),
      );
    case "different-opensteer":
      return h(
        "div.notice.notice--warn",
        {},
        h(
          "p",
          {},
          "A different Opensteer answered at this address. If yours was reset, connect again from Opensteer; otherwise this reconnects by itself.",
        ),
      );
    case "route-changed":
    case "ended":
      return h(
        `div.notice.${connection.state === "ended" ? "notice--bad" : "notice--warn"}` as "div",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            connection.state === "ended"
              ? `${name} disconnected this Chrome. ${reconnectInstructions()}`
              : `${name} moved to a new address. ${reconnectInstructions()}`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small.btn--primary",
              "Open Opensteer",
              () => void openOpensteer(connection),
              { "data-key": `fix:${key}` },
              "external-link",
            ),
          ),
        ),
      );
  }
}

function budgetNotice(connection: ConnectionView): HTMLElement | null {
  const { budget } = connection;
  if (budget.used < budget.limit) return null;
  let until: string | null = null;
  if (budget.nextAt) {
    const at = new Date(budget.nextAt);
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    until = at.toDateString() === new Date().toDateString() ? time : `tomorrow at ${time}`;
  }
  return h(
    "div.notice.notice--warn",
    {},
    icon("alert-circle"),
    h(
      "div.notice__body",
      {},
      h(
        "p",
        {},
        h("strong", {}, `${budget.limit} new sites shared today.`),
        ` ${connection.deploymentName} can't use another new site${until ? ` until ${until}` : ""} unless you allow more.`,
      ),
      h(
        "div.notice__actions",
        {},
        button(
          "btn.btn--small",
          "Allow more today",
          () => void act({ sourceId: connection.sourceId, type: "ui.budget.reset" }),
          { "data-key": `budget:${connection.sourceId}` },
        ),
      ),
    ),
  );
}

function siteRow(connection: ConnectionView, site: ConnectionView["sites"][number]): HTMLElement {
  let host: string;
  try {
    host = browserSiteDomain(site.site);
  } catch {
    host = hostOf(site.site);
  }
  const key = `${site.stopped ? "share" : "stop"}:${connection.sourceId}:${site.site}`;
  return h(
    "li.site",
    { "data-stopped": site.stopped },
    h("span.site__glyph", { "aria-hidden": "true" }, host.charAt(0)),
    h(
      "span.site__text",
      {},
      h("span.site__host", {}, host),
      h(
        "span.site__meta",
        {},
        site.stopped ? "Sharing stopped" : `Shared ${relativeTime(site.lastSharedAt)}`,
      ),
    ),
    site.stopped
      ? button(
          "site__action.site__action--share",
          "Share again",
          () => void act({ site: site.site, sourceId: connection.sourceId, type: "ui.site.share" }),
          { "aria-label": `Share ${host} again`, "data-key": key },
        )
      : button(
          "site__action",
          "Stop sharing",
          () => void act({ site: site.site, sourceId: connection.sourceId, type: "ui.site.stop" }),
          { "aria-label": `Stop sharing ${host}`, "data-key": key },
        ),
  );
}

function actions(connection: ConnectionView): HTMLElement {
  const key = connection.sourceId;
  if (confirming === key) {
    return h(
      "div.confirm",
      { role: "group", "aria-label": `Disconnect from ${connection.deploymentName}` },
      h(
        "p",
        {},
        h("strong", {}, `Disconnect Chrome from ${connection.deploymentName}?`),
        liveTabsOnly
          ? " This stops sharing tabs with that Home."
          : connection.state === "connected"
            ? ` ${connection.deploymentName} removes this Chrome too. Agents there can't use your Chrome sign-ins until you connect again.`
            : " Agents there can't use your Chrome sign-ins until you connect again. Opensteer will show this Chrome as offline until you remove it there.",
      ),
      h(
        "div.confirm__actions",
        {},
        button(
          "btn.btn--small.btn--danger",
          "Disconnect",
          () => {
            confirming = null;
            void act({ sourceId: key, type: "ui.disconnect" });
          },
          { "data-key": `confirm:${key}` },
          "log-out",
        ),
        button(
          "btn.btn--small.btn--ghost",
          "Cancel",
          () => {
            confirming = null;
            render(true, `disconnect:${key}`);
          },
          { "data-key": `cancel:${key}` },
        ),
      ),
    );
  }
  // When the fix above is already Open Opensteer, the footer does not repeat it.
  const fixOpens = connection.state === "ended" || connection.state === "route-changed";
  return h(
    "div.deployment__actions",
    {},
    fixOpens
      ? h("span")
      : button(
          "btn.btn--small",
          "Open Opensteer",
          () => void openOpensteer(connection),
          { "data-key": `open:${key}` },
          "external-link",
        ),
    button(
      "btn.btn--small.btn--ghost",
      "Disconnect",
      () => {
        confirming = key;
        render(true, `confirm:${key}`);
      },
      { "data-key": `disconnect:${key}` },
    ),
  );
}

async function shareCurrentTab(connection: ConnectionView): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await act({ sourceId: connection.sourceId, type: "ui.tab.share", tabId: tab.id });
  } else {
    problem = "Chrome couldn't find the tab to share.";
    render(true);
  }
}

function sharedTabs(connection: ConnectionView): HTMLElement | null {
  if (!connection.canShareTab) return null;
  return h(
    "section.sites",
    { "aria-label": "Shared Chrome tabs" },
    h("h3.sites__title", {}, "Shared tabs"),
    h(
      "p",
      {},
      "The agent can act as you, in this tab, on any site this Chrome is signed in to, until you stop. It can read cookies from this Chrome profile.",
    ),
    button(
      "btn.btn--small",
      "Share this tab with Opensteer",
      () => void shareCurrentTab(connection),
      { "data-key": `tab-share:${connection.sourceId}` },
    ),
    h(
      "ul.sites__list",
      {},
      ...connection.sharedTabs.map((tab) =>
        h(
          "li.site",
          {},
          h("span", { title: tab.url }, tab.title || tab.url),
          button(
            "site__action",
            "Stop sharing",
            () =>
              void act({
                sourceId: connection.sourceId,
                shareId: tab.shareId,
                type: "ui.tab.stop",
              }),
            {
              "aria-label": `Stop sharing ${tab.title || tab.url}`,
              "data-key": `tab-stop:${tab.shareId}`,
            },
          ),
        ),
      ),
    ),
  );
}

function deployment(connection: ConnectionView): HTMLElement {
  const sharing = connection.sites.filter((site) => !site.stopped).length;
  return h(
    "section.deployment",
    { "aria-label": connection.deploymentName },
    h(
      "div.deployment__head",
      {},
      h("h2.deployment__name", {}, connection.deploymentName),
      h("span.deployment__origin.mono", { title: connection.origin }, hostOf(connection.origin)),
      statusLabel(connection.state),
    ),
    fix(connection),
    liveTabsOnly ? null : budgetNotice(connection),
    liveTabsOnly
      ? null
      : h(
          "div.sites",
          {},
          h(
            "div.sites__head",
            {},
            h("h3.sites__title", {}, "Shared sites"),
            connection.sites.length ? h("span", {}, `${sharing} sharing`) : null,
          ),
          connection.sites.length
            ? h(
                "ul.sites__list",
                {
                  tabindex: connection.sites.length > 6 ? "0" : undefined,
                  "aria-label": "Shared sites",
                },
                ...connection.sites.map((site) => siteRow(connection, site)),
              )
            : h(
                "p.sites__empty",
                {},
                `None yet. A site appears here the first time ${connection.deploymentName} uses your sign-in for it.`,
              ),
        ),
    sharedTabs(connection),
    actions(connection),
  );
}

function reconnectInstructions(): string {
  return liveTabsOnly
    ? "Open a fresh Chrome pairing link from Opensteer and choose Pair Chrome tab sharing."
    : "Open Settings → Chrome in Opensteer and choose Connect Chrome.";
}

function empty(): HTMLElement {
  if (liveTabsOnly) {
    return h(
      "section.empty",
      {},
      h("p.empty__lead", {}, "Pair Chrome tab sharing with your Home"),
      h(
        "p.empty__text",
        {},
        "Open a Chrome pairing link from your Home and choose Pair Chrome tab sharing.",
      ),
      h(
        "p.empty__text",
        {},
        "The agent can act as you, in a tab you share, on any site this Chrome is signed in to, until you stop. Chrome shows a banner while a tab is shared.",
      ),
    );
  }
  return h(
    "section.empty",
    {},
    h("p.empty__lead", {}, "Let your agents use the sites you're signed in to here."),
    h(
      "p.empty__text",
      {},
      "Nothing is shared until you allow a site in Opensteer, and Chrome tells you each time a new site is shared.",
    ),
    h(
      "p.empty__step",
      {},
      "In Opensteer, open ",
      h("strong", {}, "Settings → Chrome"),
      " and choose ",
      h("strong", {}, "Connect Chrome"),
      ".",
    ),
  );
}

function render(force = false, focusKey?: string): void {
  if (!current) return;
  const active = focusKey ?? (document.activeElement as HTMLElement | null)?.dataset.key;
  const children: HTMLElement[] = current.connections.length
    ? current.connections.map(deployment)
    : [empty()];
  for (const id of current.quarantined)
    children.push(
      h(
        "section.notice.notice--warn",
        {},
        h("p", {}, "A saved connection couldn't be read. Connect again."),
        button("btn.btn--small", "Forget", () => void act({ type: "ui.quarantine.forget", id })),
      ),
    );
  if (problem) {
    children.unshift(
      h("p.notice.notice--bad.popup__problem", { role: "alert" }, icon("alert-circle"), problem),
    );
  }
  // Only what the popup shows decides whether it is redrawn. A status that
  // changes nothing visible, such as another reconnect attempt, must not
  // replace the button under the person's cursor.
  const markup = children.map((child) => child.outerHTML).join("");
  if (!force && markup === lastRendered) return;
  lastRendered = markup;
  root.replaceChildren(...children);
  root.setAttribute("aria-busy", "false");
  if (active) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.focus();
}

async function refresh(): Promise<void> {
  const result = await askWorker({ type: "ui.status" }, StatusSchema);
  if (result.ok) {
    current = result.value;
    render();
  } else if (!current) {
    current = { connections: [], quarantined: [] };
    problem = "Opensteer's extension isn't responding. Close this and try again.";
    render(true);
  }
}

void refresh();
setInterval(() => void refresh(), 1_500);
