// The Web Crypto surface Hermes lacks is installed before anything that reads
// it is imported, which is why this line is first and why it stands alone.
import "./src/runtime.js";

import { registerRootComponent } from "expo";
import { App } from "./src/app.js";

registerRootComponent(App);
