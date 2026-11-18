import { space } from "../theme.js";

/** The connection pill's height, which a bar row centres it in. */
export const pillHeight = 36;

/**
 * Room a transcript leaves under its bar for the pill, kept whether or not the
 * pill shows: the newest words are never under it, and nothing moves when it comes.
 */
export const pillRowClearance = pillHeight + space[8];
