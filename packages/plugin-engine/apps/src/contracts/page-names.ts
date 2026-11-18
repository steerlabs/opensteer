/**
 * The routes and names the framework and the Host reserve on an app's origin and in its page.
 * Every route below `reservedSegment` belongs to them, never to the app.
 */
export const reservedSegment = "_plugin-engine";
/** Public files may not use this prefix: their paths are served from the app's origin. */
export const reservedPublicPrefix = `${reservedSegment}/`;
/** Server-sent events naming the active version, which the page watches to reload. */
export const versionPath = `/${reservedSegment}/version`;
/** Each version's browser assets, below its version id. */
export const assetsPath = `/${reservedSegment}/assets/`;
/** Where the page reports its own failures. */
export const browserTracePath = `/${reservedSegment}/api/telemetry/traces`;
export const queryPath = `/${reservedSegment}/api/query`;
export const mutatePath = `/${reservedSegment}/api/mutate`;
export const subscribePath = `/${reservedSegment}/api/subscribe`;
/** Host-owned sign-in callback on every app origin. */
export const signInPath = `/${reservedSegment}/auth/callback`;
/** The JSON element that gives the page its context, such as its version. */
export const contextElement = "plugin-engine-context";
/** The JSON element that lists the page's account notices. */
export const accountNoticeElement = "plugin-engine-account-notice";
/** Dispatched on `window` when a new version is active. */
export const deploymentEvent = "plugin-engine:deployment-changed";
/** Marks where the framework puts its scripts in a built page. */
export const uiMarkerData = "plugin-engine-ui";
export const uiMarker = `<!--${uiMarkerData}-->`;
