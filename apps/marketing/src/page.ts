import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces/opsz.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/page.css";
import { watchNav } from "./dom.js";

watchNav();

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(button.dataset.copy ?? "").then(() => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
  });
}

// iPadOS reports itself as a Mac, so only phones see this.
if (/iPhone|iPod|Android/.test(navigator.userAgent)) {
  for (const note of document.querySelectorAll<HTMLElement>("[data-on-phone]")) note.hidden = false;
}
