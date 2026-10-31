const listeners = new Set<() => void>();
const remoteEditors = new Set<symbol>();
let drawer = false;

/**
 * The person's own step that no navigation shows — a press into a live page
 * or display, opening its keyboard, focusing or editing a text field, or the
 * drawer opening — so a presentation captured before it must not land after.
 */
export function interact(): void {
  for (const listener of listeners) listener();
}

export function observeInteraction(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Native remote keyboards are not registered with React Native's TextInput.State. */
export function remoteEditing(): boolean {
  return remoteEditors.size > 0;
}

/** Closing a keyboard also invalidates utterances heard while it was open. */
export function holdRemoteEditing(): () => void {
  const owner = Symbol();
  remoteEditors.add(owner);
  interact();
  return () => {
    if (remoteEditors.delete(owner)) interact();
  };
}

/** The drawer lies over the screen from the moment it starts to cover it until it has left. */
export function drawerOpen(): boolean {
  return drawer;
}

export function setDrawerOpen(open: boolean): void {
  if (open === drawer) return;
  drawer = open;
  if (open) interact();
}
