import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/site.css";
import { mountDemo } from "./demo/index.js";
import { byId } from "./dom.js";
import { startSections } from "./sections.js";
import { mountTeam } from "./team.js";

mountDemo(byId("demo"), byId("rail"));
startSections();
mountTeam();
