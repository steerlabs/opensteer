import { browserSourceTabDetachWire } from "@opensteer/browser-source-wire/frames";

export const liveTabsOnly = OPENSTEER_LIVE_TABS;
export const extensionWire = OPENSTEER_LIVE_TABS ? browserSourceTabDetachWire : 5;
