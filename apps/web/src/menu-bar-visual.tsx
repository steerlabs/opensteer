import { createRoot } from "react-dom/client";
import type { MenuBarStatus, OpensteerMenuBarBridge } from "@opensteer/client/computers";
import { MenuBarPopover } from "./desktop/menu-bar-popover.js";
import { menuBarStates, type MenuBarStateName } from "./desktop/menu-bar-states.js";
import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/menu-bar.css";

/** One popover state at the popover's own width, from `?state=`, for screenshots. */
const params = new URLSearchParams(window.location.search);
const name = params.get("state") ?? "localHome";
const status: MenuBarStatus | null =
  name === "loading" ? null : (menuBarStates[name as MenuBarStateName] ?? null);
const idle = async () => undefined;
const bridge: OpensteerMenuBarBridge = {
  status: () => (status ? Promise.resolve(status) : new Promise(() => undefined)),
  onStatus: () => () => undefined,
  setSwitch: idle,
  openRow: idle,
  stop: idle,
  resume: idle,
  setOpenAtLogin: idle,
  openApp: idle,
  openNeedsYou: idle,
  openSettings: idle,
  quitCompletely: idle,
};
document.body.style.width = "300px";
const root = document.getElementById("root");
if (!root) throw new Error("Menu bar visual root was not found.");
createRoot(root).render(<MenuBarPopover bridge={bridge} />);
if (params.get("menu") === "open")
  queueMicrotask(() =>
    setTimeout(() => document.querySelector<HTMLButtonElement>(".menu-bar__more")?.click(), 0),
  );
