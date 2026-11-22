/** A call refused because Expo's component has no tag for the view yet: it waits for the view. */
export class ViewNotMountedError extends Error {
  constructor() {
    super("The view is not mounted yet.");
    this.name = "ViewNotMountedError";
  }
}
