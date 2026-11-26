// @vitest-environment happy-dom
import { lazy, Suspense, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerEditor } from "./composer-editor.js";
import { composerField } from "./composer-editor.test-support.js";

// Real timers and no act(): act flushes a render synchronously, and what fails here only
// happens when React yields to the event loop between rendering the editor and committing it.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

let root: Root | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

/** Rendering that outlasts one of React's time slices, after the composer in the same pass. */
function SlowRest() {
  const until = performance.now() + 30;
  while (performance.now() < until) {
    // The rest of a large signed-in screen.
  }
  return <p>The rest of the screen</p>;
}

describe("a composer in a screen whose first render yields before it commits", () => {
  // The desktop renders the signed-in app as a lazily loaded screen: once its code arrives,
  // React renders it as a Suspense retry, in time slices. TipTap's useEditor schedules the
  // destruction of an editor its component has not mounted 1 ms after creating it; when the
  // render yields after the composer and before the commit, that timer has run.
  it("mounts its field and never reads the editor's view before it has one", async () => {
    const failures: unknown[] = [];
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node, {
      onCaughtError: (error) => failures.push(error),
      onUncaughtError: (error) => failures.push(error),
      onRecoverableError: (error) => failures.push(error),
    });
    let fieldElement: HTMLElement | null = null;
    function Screen() {
      return (
        <>
          <ComposerEditor
            autoFocus
            className="composer__input"
            fieldAttributes={{ "aria-label": "Message", "data-composer-input": "" }}
            fieldRef={(element) => {
              fieldElement = element;
            }}
            onChange={() => undefined}
            placeholder="Ask your agent to…"
            value="Draft kept from before"
          />
          <SlowRest />
        </>
      );
    }
    let arrive!: (module: { default: ComponentType }) => void;
    const SignedIn = lazy(
      () => new Promise<{ default: ComponentType }>((resolve) => (arrive = resolve)),
    );
    root.render(
      <Suspense fallback={<p>Opening…</p>}>
        <SignedIn />
      </Suspense>,
    );
    await vi.waitFor(() => expect(node.textContent).toContain("Opening…"));
    arrive({ default: Screen });
    await vi.waitFor(
      () => {
        expect(failures).toEqual([]);
        expect(node.textContent).toContain("The rest of the screen");
        const field = composerField(node, "Message");
        expect(field.getAttribute("role")).toBe("textbox");
        expect(field.getAttribute("aria-placeholder")).toBe("Ask your agent to…");
        expect(field.textContent).toBe("Draft kept from before");
        expect(fieldElement).toBe(field);
      },
      { timeout: 3_000 },
    );
    // The focus it was owed is taken by the editor that has a view, and nothing failed on the way.
    await vi.waitFor(() => expect(document.activeElement).toBe(composerField(node, "Message")));
    expect(failures).toEqual([]);
  });
});
