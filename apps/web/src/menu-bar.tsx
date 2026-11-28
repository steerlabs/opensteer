import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { OpensteerMenuBarBridge } from "@opensteer/client/computers";
import { MenuBarPopover } from "./desktop/menu-bar-popover.js";
import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/menu-bar.css";

declare global {
  interface Window {
    readonly opensteerMenuBar?: OpensteerMenuBarBridge;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Opensteer menu bar root was not found.");
const bridge = window.opensteerMenuBar;
if (bridge)
  createRoot(root).render(
    <StrictMode>
      <MenuBarPopover bridge={bridge} />
    </StrictMode>,
  );
