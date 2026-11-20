import { browserSourceTabWire } from "@opensteer/browser-source-wire/frames";

export const liveTabsOnly = OPENSTEER_LIVE_TABS;
export const extensionWire = OPENSTEER_LIVE_TABS ? browserSourceTabWire : 5;
