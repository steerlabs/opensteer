import { expect, it } from "vitest";
import { asRecord, startFollowSession } from "./chromium.test-support.js";

it.each(["viewer", "agent"] as const)(
  "cancels a real HTML drag without dropping it (%s CDP session)",
  async (producer) => {
    const session = await startFollowSession({ path: "/plain" });
    const surfaceId = session.rootSurfaceId;
    await session.read(
      surfaceId,
      `(() => {
      document.body.innerHTML = '<div id="source" draggable="true" style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:red">Drag</div><div id="target" style="position:absolute;left:300px;top:20px;width:200px;height:200px;background:blue">Drop</div>';
      window.dragEvents = [];
      source.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'drag'); window.dragEvents.push('dragstart'); });
      target.addEventListener('dragover', e => { e.preventDefault(); window.dragEvents.push('dragover'); });
      target.addEventListener('drop', e => { e.preventDefault(); window.dragEvents.push('drop'); });
      source.addEventListener('dragend', e => window.dragEvents.push('dragend:' + e.dataTransfer.dropEffect));
    })()`,
    );
    await session.controller.handle({ type: "stream.subscribe" });
    const { width, height } = await session.pageState(surfaceId);
    await session.frameAt(surfaceId, { width, height });
    const attached =
      producer === "agent"
        ? String(
            asRecord(
              await session.agent("Target.attachToTarget", {
                targetId: session.rootTargetId,
                flatten: true,
              }),
            ).sessionId,
          )
        : null;
    const pointer = async (action: "down" | "move" | "up", x: number) => {
      if (attached) {
        await session.agent(
          "Input.dispatchMouseEvent",
          {
            type:
              action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved",
            button: "left",
            buttons: action === "up" ? 0 : 1,
            clickCount: 1,
            x,
            y: 60,
          },
          attached,
        );
      } else {
        await session.controller.handle({
          type: "input.pointer",
          surfaceId,
          action,
          button: action === "move" ? "none" : "left",
          x: x / width,
          y: 60 / height,
          viewportWidth: width,
          viewportHeight: height,
        });
      }
    };
    const drag = async () => {
      await session.read(surfaceId, "window.dragEvents = []");
      await pointer("move", 60);
      await pointer("down", 60);
      await pointer("move", 80);
      await pointer("move", 340);
      await pointer("move", 360);
      expect(await session.read(surfaceId, "window.dragEvents")).toEqual(
        expect.arrayContaining(["dragstart", "dragover"]),
      );
    };
    // Prove the fixture accepts a deliberate drop with the same input sequence.
    await drag();
    await pointer("up", 360);
    expect(await session.read(surfaceId, "window.dragEvents")).toContain("drop");
    if (!attached) {
      expect(await session.read(surfaceId, "target.matches(':hover')")).toBe(true);
      await session.controller.handle({
        type: "input.pointer",
        surfaceId,
        action: "leave",
        button: "none",
        x: 360 / width,
        y: 60 / height,
        viewportWidth: width,
        viewportHeight: height,
      });
      expect(await session.read(surfaceId, "target.matches(':hover')")).toBe(false);
    }
    await drag();
    if (attached) await session.agent("Target.detachFromTarget", { sessionId: attached });
    else await session.controller.handle({ type: "input.cancel", surfaceId });
    const events = await session.read(surfaceId, "window.dragEvents");
    expect(events).toContain("dragend:none");
    expect(events).not.toContain("drop");
    expect(session.errors()).toEqual([]);
  },
);
