import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/site.css";
import { mountConsent } from "./demo/consent.js";
import { mountWatch } from "./demo/phone.js";
import { byId } from "./dom.js";
import { startSections } from "./sections.js";

startSections();
mountWatch(
  byId("watchPhone"),
  document.querySelector<HTMLElement>('[data-part="claudeState"]'),
  byId("showHint"),
);
mountConsent(byId("consent"));
