// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./app-error-boundary.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "opensteerDesktop");
});

it("leaves a way back after a render failure and logs only where it happened", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const reportRendererFailure = vi.fn(async () => undefined);
  Object.assign(window, { opensteerDesktop: { reportRendererFailure } });
  const secret = "os_secret_PRIVATE";
  const Failing = () => {
    const error = new TypeError(`Could not read ${secret}`);
    error.stack = `TypeError: Could not read ${secret}\n    at Failing (app.js:1:2)`;
    throw error;
  };
  const container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container).render(
      <AppErrorBoundary>
        <Failing />
      </AppErrorBoundary>,
    );
  });

  expect(container.textContent).toContain("Something went wrong");
  expect(container.querySelector("button")?.textContent).toContain("Reload");
  expect(reportRendererFailure).toHaveBeenCalledOnce();
  const [record] = reportRendererFailure.mock.calls[0] as unknown as [
    { errorFrames: string[]; errorName: string; componentFrames: string[] },
  ];
  expect(record.errorName).toBe("TypeError");
  expect(record.errorFrames).toEqual(["at Failing (app.js:1:2)"]);
  expect(JSON.stringify(record)).not.toContain(secret);
});
