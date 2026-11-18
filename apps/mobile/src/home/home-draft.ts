/*
 * Mobile claims a Home draft and freezes its message and both keys in one write.
 * Creation binds a task ID, and the outbox's receipt commits the first message.
 * Reload and reconnect resume the same binding under its login. A first, definite
 * creation refusal can return the whole message to the draft in one write. A
 * replay or a failed handoff stays held until Retry or explicit removal from Home.
 * If enqueue already committed, only the outbox owns delivery.
 */
/**
 * The one unsent new task each person keeps per computer. Home shows it and
 * restores it on every return; anywhere else that starts a task writes here.
 */
export const homeDraftId = "home";
