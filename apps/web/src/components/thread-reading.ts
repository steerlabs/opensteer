import { windowInForeground } from "../ui-utils.js";

/**
 * Which conversation this window is reading, and whether it is on its live
 * tail. A notification is suppressed only when all three hold — window in
 * front, same Thread, at its latest — because somebody scrolled back through
 * older history never saw the new message arrive.
 *
 * A mutable value rather than a context: nothing renders from it, and
 * publishing it through React would re-render the transcript on every scroll.
 */
let reading: { readonly atLatest: boolean; readonly threadId: string } | null = null;

export function setThreadReading(value: { atLatest: boolean; threadId: string } | null): void {
  reading = value;
}

/** Whether what just arrived in this Thread is being read as it arrives. */
export function isReadingThread(threadId: string): boolean {
  if (reading === null || reading.threadId !== threadId || !reading.atLatest) return false;
  return windowInForeground();
}
