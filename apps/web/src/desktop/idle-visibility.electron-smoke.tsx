import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { HttpHostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList } from "@opensteer/client/host";
import { browserClientLifecycle } from "../host/browser-lifecycle.js";
import { pageVisible } from "../page-visibility.js";
import { Viewfinder } from "../components/workspace/viewfinder.js";
import { OwnerView } from "../components/workspace/owner-view.js";
import { ownerViewDestination } from "../components/workspace/owner-views.js";
import { WorkspaceProvider } from "../components/workspace/workspace-context.js";
import { useWorkspaceNavigation } from "../components/workspace/navigation.js";
import { TabCloserProvider } from "../components/workspace/tab-closer.js";
import { ToastProvider } from "../components/toast.js";

const events: string[] = [];
const counts = {
  captures: 0,
  openDisplays: 0,
  retains: 0,
  releases: 0,
  renewals: 0,
  finderRetains: 0,
  finderReleases: 0,
};
let dispose: (() => void) | null = null;
let documentVisible = true;
// A lock must work even when Chromium still says the document is visible.
Object.defineProperty(document, "visibilityState", {
  get: () => (documentVisible ? "visible" : "hidden"),
});
const root = createRoot(document.body.appendChild(document.createElement("div")));

const smoke = {
  async start(origin: string, sessionId: string, surfaceId: string) {
    const client = new HttpHostClient({
      baseUrl: origin,
      lifecycle: browserClientLifecycle(),
      refreshIntervalMs: 0,
    });
    await client.load();
    const control = client.retainBrowserViewer(sessionId, surfaceId);
    const watch = client.retainBrowserWatch(sessionId, surfaceId);
    const owner = new MockHostClient({ latencyMs: 0, lifecycle: browserClientLifecycle() });
    await owner.load();
    const approved = (await owner.listApprovedComputerApps()).find(
      (entry) => entry.target.kind === "app",
    );
    if (!approved) throw Error("No fixture app is approved.");
    const view = await owner.openComputerView(approved.machineId, approved.target);
    const destination = ownerViewDestination(view);
    if (destination.kind !== "app") throw Error("Expected a Mac owner view.");
    const ownerDestination = destination;
    const snapshot = owner.getSnapshot();
    const finderPlace = placeList(snapshot).find((place) => place.destination.kind === "browser");
    const finderThread = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId);
    if (!finderPlace || !finderThread) throw Error("No fixture browser viewfinder exists.");
    const finder = {
      place: {
        placeKey: finderPlace.key,
        runId: null,
        destination: finderPlace.destination,
        title: finderPlace.title,
        site: finderPlace.site,
      },
      threadId: finderThread.id,
    };
    const retainWatch = owner.retainBrowserWatch;
    Object.defineProperty(owner, "retainBrowserWatch", {
      value: (...args: Parameters<typeof retainWatch>) => {
        counts.finderRetains++;
        const release = retainWatch(...args);
        return () => {
          counts.finderReleases++;
          release();
        };
      },
    });
    const lifecycle = owner.subscribeLifecycle;
    Object.defineProperty(owner, "subscribeLifecycle", {
      value: (listener: Parameters<typeof lifecycle>[0]) => {
        events.push("lifecycle-subscribed");
        return lifecycle((event) => {
          events.push(`lifecycle:${event}`);
          listener(event);
        });
      },
    });
    const capture = owner.connectComputerDisplay.bind(owner);
    const retain = owner.retainComputerView;
    const dispatch = owner.rpc["commands.dispatch"];
    Object.defineProperty(owner, "connectComputerDisplay", {
      value: (...args: Parameters<typeof capture>) => {
        counts.captures++;
        const socket = capture(...args);
        counts.openDisplays++;
        socket.addEventListener("close", ({ code }) => {
          counts.openDisplays--;
          events.push(`display-close:${code}`);
        });
        return socket;
      },
    });
    Object.defineProperty(owner, "retainComputerView", {
      value: (...args: Parameters<typeof retain>) => {
        counts.retains++;
        const held = retain(...args);
        return {
          ...held,
          release: () => {
            counts.releases++;
            held.release();
          },
        };
      },
    });
    Object.defineProperty(owner.rpc, "commands.dispatch", {
      value: (...args: Parameters<typeof dispatch>) => {
        if (args[0].type === "computer.view.renew") counts.renewals++;
        return dispatch(...args);
      },
    });
    function Owner() {
      const snapshot = owner.getSnapshot();
      const nav = useWorkspaceNavigation(
        { deploymentId: snapshot.deploymentId, userId: snapshot.user?.id ?? null },
        snapshot.homeThreadId,
      );
      return (
        <WorkspaceProvider attention={0} nav={nav} openDrawer={() => undefined}>
          <TabCloserProvider hostClient={owner}>
            <Viewfinder hostClient={owner} place={finder.place} threadId={finder.threadId} />
            <OwnerView
              destination={ownerDestination}
              marks={null}
              hostClient={owner}
              hostConnected
              leading={null}
              place={null}
              trailing={null}
            />
          </TabCloserProvider>
        </WorkspaceProvider>
      );
    }
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <Owner />
        </ToastProvider>
      </MemoryRouter>,
    );
    dispose = () => {
      root.unmount();
      control();
      watch();
      client.dispose();
      owner.dispose();
    };
  },
  snapshot: () => ({ visible: pageVisible(), documentVisible, ...counts, events: [...events] }),
  documentVisible(visible: boolean) {
    documentVisible = visible;
    document.dispatchEvent(new Event("visibilitychange"));
  },
  stop: () => dispose?.(),
};
Object.assign(window, { idleLifecycleSmoke: smoke });
