/**
 * The one limit for a CDP message on an agent's path to a browser, at every hop: the browser's
 * side (its runtime, and the pool relay's frame), the Host's CDP route, the Runner's relay and the
 * Browser Harness in a Run. 8 MiB: a screenshot of an ordinary page, base64 in its answer, fits (a
 * 1920×1080 PNG of 1 to 4 MB is 1.4 to 5.4 MB of base64). No hop on the way is smaller than the one
 * before it, so a too-large answer is refused where it starts, by the router beside the browser,
 * as a failure of that one command; a hop that can only close its socket never meets one.
 */
export const standardCdpMessageMaxBytes = 8 * 1024 * 1024;
/**
 * The largest answer the router beside the browser passes: the message limit less room for the
 * id and session id that wrap it. A larger one fails its command, naming its size and this limit.
 */
export const standardCdpAnswerMaxBytes = standardCdpMessageMaxBytes - 4_096;
export const standardCdpBufferedMaxBytes = 2 * standardCdpMessageMaxBytes;
export const standardCdpMaxPending = 128;
