import {
  ConnectResultSchema,
  InvitationCheckSchema,
  askWorker,
  type ConnectProblemCode,
  type InvitationCheck,
  type UiProblem,
} from "./messages.js";
import { h, hostOf, icon, requireElement } from "./ui.js";

type PageState = "verifying" | "idle" | "connecting" | "success" | "error";

const root = requireElement<HTMLElement>("#connect");
const title = requireElement<HTMLHeadingElement>("#title");
const deploymentLine = requireElement<HTMLElement>("#deployment");
const body = requireElement<HTMLElement>("#body");
const form = requireElement<HTMLFormElement>("#form");
const nameInput = requireElement<HTMLInputElement>("#name");
const note = requireElement<HTMLElement>("#note");
const submit = requireElement<HTMLButtonElement>("#submit");
const actions = requireElement<HTMLElement>("#actions");
const live = requireElement<HTMLElement>("#live");

const closeDelayMs = 1_200;

function setState(state: PageState): void {
  root.dataset.state = state;
  root.setAttribute("aria-busy", String(state === "verifying" || state === "connecting"));
}

function announce(text: string): void {
  live.textContent = text;
}

/** The Deployment's own name is secondary: any Opensteer can call itself "Home". */
function showDeployment(name: string | null, origin: string | null = null): void {
  deploymentLine.hidden = !name;
  deploymentLine.replaceChildren(
    ...(name ? [h("span.connect__deployment-key", {}, "Named"), h("span", {}, name)] : []),
  );
  if (origin) deploymentLine.title = origin;
  else deploymentLine.removeAttribute("title");
}

/** The address is the headline: it is the one thing a look-alike page cannot copy. */
function addressTitle(prefix: string, origin: string): (Node | string)[] {
  return [prefix, h("span.connect__host", {}, hostOf(origin))];
}

async function closeOwnTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Fall through: a window this page opened itself can still close.
  }
  window.close();
}

function closeButton(label = "Close this tab"): HTMLButtonElement {
  const button = h("button.btn.btn--ghost", { type: "button" }, label);
  button.addEventListener("click", () => void closeOwnTab());
  return button;
}

async function defaultName(): Promise<string> {
  try {
    const { os } = await chrome.runtime.getPlatformInfo();
    const names: Record<string, string> = {
      cros: "Chrome on ChromeOS",
      linux: "Chrome on Linux",
      mac: "Chrome on Mac",
      win: "Chrome on Windows",
    };
    return names[os] ?? "Chrome";
  } catch {
    return "Chrome";
  }
}

interface ProblemCopy {
  action?: "retry" | "download";
  body: (Node | string)[];
  title: string;
}

function problemCopy(problem: Pick<UiProblem, "code" | "deploymentName" | "origin">): ProblemCopy {
  const name = problem.deploymentName ?? "Opensteer";
  const again = "Go back to Opensteer and choose Connect Chrome again.";
  const copies: Record<ConnectProblemCode | "framed", ProblemCopy> = {
    busy: {
      action: "retry",
      body: ["Chrome is finishing another connection. Try again in a moment."],
      title: "One moment",
    },
    expired: {
      body: [`Connection links work once, for 15 minutes. ${again}`],
      title: "This link expired",
    },
    failed: {
      action: "retry",
      body: [`Chrome couldn't finish connecting. Try again, or ${again.toLowerCase()}`],
      title: "Something went wrong",
    },
    framed: {
      body: [`For your safety, Chrome connects only from its own tab. ${again}`],
      title: "Open this page on its own",
    },
    invalid: {
      body: [`This isn't a working Opensteer connection link. ${again}`],
      title: "This link doesn't work",
    },
    mismatch: {
      body: [
        "Something else is answering at ",
        h("span.mono", {}, problem.origin ?? "that address"),
        `, not ${name}. ${again}`,
      ],
      title: "This isn't the Opensteer that sent you",
    },
    missing: {
      body: ["In Opensteer, open Settings → Chrome and choose Connect Chrome."],
      title: "Open this from Opensteer",
    },
    "not-from-opensteer": {
      body: [
        "Choose Connect Chrome there, and Opensteer opens this page for you. Chrome connects only to the Opensteer that opened it.",
      ],
      title: "Open this from Opensteer",
    },
    rejected: {
      body: [`${name} didn't accept this link. It may have been used already. ${again}`],
      title: "Link not accepted",
    },
    unreachable: {
      action: "retry",
      body: [
        "Make sure Opensteer is running",
        ...(problem.origin ? [" at ", h("span.mono", {}, problem.origin)] : []),
        ", then try again.",
      ],
      title: `Chrome can't reach ${name}`,
    },
    update: {
      ...(problem.origin ? { action: "download" as const } : {}),
      body: [
        "This version of the extension can't connect to ",
        name,
        ". Download the latest extension from Opensteer, replace the folder you installed, then choose Reload on Opensteer in ",
        h("span.mono", {}, "chrome://extensions"),
        ".",
      ],
      title: "Update the extension",
    },
  };
  return copies[problem.code];
}

function showProblem(
  problem: Pick<UiProblem, "code" | "deploymentName" | "origin"> | { code: "framed" },
  retry: (() => void) | null,
): void {
  const full = { deploymentName: null, origin: null, ...problem };
  const copy = problemCopy(full as Parameters<typeof problemCopy>[0]);
  setState("error");
  form.hidden = true;
  title.textContent = copy.title;
  showDeployment(null);
  body.replaceChildren(...copy.body);
  const buttons: HTMLElement[] = [];
  if (copy.action === "retry" && retry) {
    const button = h("button.btn.btn--primary", { type: "button" }, icon("reload"), "Try again");
    button.addEventListener("click", retry);
    buttons.push(button);
  }
  if (copy.action === "download" && full.origin) {
    buttons.push(
      h(
        "a.btn.btn--primary",
        { href: new URL("/browser-extension.zip", full.origin).href, download: "" },
        icon("download"),
        "Download update",
      ),
    );
  }
  buttons.push(closeButton());
  actions.replaceChildren(...buttons);
  actions.hidden = false;
  announce(`${copy.title}. ${body.textContent ?? ""}`);
  title.focus();
}

function showFinished(heading: string, text: string, close: boolean): void {
  setState("success");
  form.hidden = true;
  title.textContent = heading;
  showDeployment(null);
  body.textContent = text;
  announce(`${heading}. ${text}`);
  if (close) {
    actions.hidden = true;
    setTimeout(() => void closeOwnTab(), closeDelayMs);
  } else {
    actions.replaceChildren(closeButton());
    actions.hidden = false;
  }
}

function showReady(check: InvitationCheck, name: string, invitation: string): void {
  const host = hostOf(check.origin);
  setState("idle");
  title.replaceChildren(...addressTitle("Connect Chrome to Opensteer at ", check.origin));
  showDeployment(check.deploymentName, check.origin);
  body.textContent = `This Opensteer can use your sign-in for a website only after you allow that site there. Chrome notifies you each time a new site is shared.`;
  nameInput.value = check.name ?? name;
  note.hidden = check.existing !== "reconnect";
  note.textContent =
    check.existing === "reconnect"
      ? `This replaces this Chrome's earlier connection to ${host}. Sites you stopped sharing stay stopped.`
      : "";
  actions.hidden = true;
  form.hidden = false;
  submit.removeAttribute("aria-disabled");
  submit.textContent = "Connect";
  announce(title.textContent);
  nameInput.focus();
  nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);

  let busy = false;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    const chosen = nameInput.value.trim();
    if (!chosen) {
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      return;
    }
    nameInput.removeAttribute("aria-invalid");
    busy = true;
    setState("connecting");
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = "Connecting…";
    announce(`Connecting to Opensteer at ${host}`);
    void askWorker({ invitation, name: chosen, type: "ui.connect" }, ConnectResultSchema).then(
      (result) => {
        busy = false;
        if (!result.ok) {
          showProblem(result, () => void start(invitation));
          return;
        }
        if (result.value.ready) {
          showFinished(
            "Connected",
            `Chrome is connected to Opensteer at ${host}. This tab closes by itself.`,
            true,
          );
        } else {
          showFinished(
            "Connected",
            `Chrome will finish connecting as soon as it can reach Opensteer at ${host}.`,
            false,
          );
        }
      },
    );
  };
}

async function start(invitation: string): Promise<void> {
  setState("verifying");
  title.textContent = "Checking this link";
  showDeployment(null);
  body.textContent = "";
  form.hidden = true;
  actions.hidden = true;
  announce("Checking this link");
  const [check, name] = await Promise.all([
    askWorker({ invitation, type: "ui.invitation.check" }, InvitationCheckSchema),
    defaultName(),
  ]);
  if (!check.ok) {
    showProblem(check, () => void start(invitation));
    return;
  }
  showReady(check.value, name, invitation);
}

// Another page could frame this one to borrow its Connect button.
if (window.top !== window) {
  showProblem({ code: "framed" }, null);
  actions.hidden = true;
} else {
  // The invitation is a one-use secret: read it once and keep it out of
  // history, sync and anything that later reads this tab's address. A second
  // link opened into this same tab arrives as a fragment change.
  const takeInvitation = (): void => {
    let invitation = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    try {
      invitation = decodeURIComponent(invitation);
    } catch {
      invitation = "";
    }
    void start(invitation);
  };
  window.addEventListener("hashchange", takeInvitation);
  takeInvitation();
}
