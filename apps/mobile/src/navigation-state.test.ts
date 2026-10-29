import { describe, expect, it } from "vitest";
import {
  deploymentRoot,
  deploymentsRoot,
  linkedSelectionFailureIsCurrent,
  selectionMayReconcileLinkedRoot,
  selectionRootTransition,
  threadReturn,
  threadRoot,
} from "./navigation-state.js";

describe("returning to a thread from a sheet", () => {
  const destination = { deploymentId: "dep_1", threadId: "thr_1" };
  const home = { name: "Home", params: { deploymentId: "dep_1" } };

  it("goes back to the thread the sheet was opened over", () => {
    expect(
      threadReturn(
        [home, { name: "Thread", params: destination }, { name: "Computer" }],
        destination,
      ),
    ).toBe("pop-to");
  });

  it("opens another thread from the list rather than over the sheet", () => {
    expect(
      threadReturn(
        [
          home,
          { name: "Thread", params: { ...destination, threadId: "thr_2" } },
          { name: "Computer" },
        ],
        destination,
      ),
    ).toBe("push-from-top");
    expect(threadReturn([home, { name: "Settings" }, { name: "Computer" }], destination)).toBe(
      "push-from-top",
    );
  });
});

describe("mobile root navigation", () => {
  it("keeps Chat as the selected deployment's root", () => {
    expect(deploymentRoot("dep_one")).toEqual({
      index: 0,
      routes: [{ name: "Home", params: { deploymentId: "dep_one" } }],
    });
  });

  it("opens an exact deep-linked thread above that deployment's Chat", () => {
    expect(
      threadRoot({ deploymentId: "dep_two", requestId: "req_one", threadId: "thr_one" }),
    ).toEqual({
      index: 1,
      routes: [
        { name: "Home", params: { deploymentId: "dep_two" } },
        {
          name: "Thread",
          params: { deploymentId: "dep_two", requestId: "req_one", threadId: "thr_one" },
        },
      ],
    });
  });

  it("does not let a remembered selection erase a linked thread while selection catches up", () => {
    expect(
      selectionMayReconcileLinkedRoot({
        linkedDeploymentId: "dep_two",
        selectionDeploymentId: "dep_one",
      }),
    ).toBe(false);
    expect(
      selectionMayReconcileLinkedRoot({
        linkedDeploymentId: "dep_two",
        selectionDeploymentId: "dep_two",
      }),
    ).toBe(true);
  });

  it("lets only the newest failed link release its protected root", () => {
    expect(
      linkedSelectionFailureIsCurrent({
        currentAttempt: 2,
        failedAttempt: 1,
        failedDeploymentId: "dep_one",
        linkedDeploymentId: "dep_two",
      }),
    ).toBe(false);
    expect(
      linkedSelectionFailureIsCurrent({
        currentAttempt: 2,
        failedAttempt: 2,
        failedDeploymentId: "dep_two",
        linkedDeploymentId: "dep_two",
      }),
    ).toBe(true);
  });

  it("moves a hydrated catalog directly into its selected deployment", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "Deployments",
        baseDeploymentId: null,
        baseRouteName: "Deployments",
        deploymentId: "dep_one",
      }),
    ).toEqual(deploymentRoot("dep_one"));
  });

  it("defers a selection change while modal work is open", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "Settings",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toBe("defer");
  });

  it("replaces the root beneath a thread-bound sheet rather than deferring", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "ThreadSettings",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toEqual(deploymentRoot("dep_two"));
  });

  it("replaces another deployment root after a deferred selection settles", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "TaskSearch",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toEqual(deploymentRoot("dep_two"));
  });

  it("returns to onboarding only when the selection itself is cleared", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "Thread",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: null,
      }),
    ).toEqual(deploymentsRoot());
  });
});
