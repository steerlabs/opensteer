import { taskMark } from "@opensteer/client/host";
import type { DesktopGlassScene } from "@opensteer/protocol/desktop";
import { useLayoutEffect, useRef, useState } from "react";
import { BrowserCropCue } from "../browser/browser-crop-cue.js";
import { taskCursorPaint } from "./task-mark.js";
import { CursorMark, CursorMotion } from "./cursor-motion.js";

/**
 * The same decorative marks in the click-through glass and in the raised app
 * layer. Each starts from the scene's positions, so switching between them
 * never glides; points measured in new page geometry snap there, and a cursor
 * whose record is `leaving` fades out. The size only keeps names inside.
 */
export function GlassScene({
  scene,
  width,
  height,
}: {
  readonly scene: DesktopGlassScene;
  readonly width: number;
  readonly height: number;
}) {
  const [motion] = useState(() => new CursorMotion());
  const geometry = useRef<number | null>(null);
  useLayoutEffect(() => {
    motion.setReducedMotion(scene.reducedMotion);
    const previous = geometry.current;
    geometry.current = scene.geometryRevision;
    motion.setSpace({ picture: { left: 0, top: 0, width, height }, unit: "pixel" });
    for (const cursor of scene.cursors)
      if (cursor.leaving) motion.leave(cursor.threadId);
      else
        motion.place(
          cursor.threadId,
          { x: cursor.x, y: cursor.y },
          {
            arrive: previous !== null,
            snap: previous !== null && previous !== scene.geometryRevision,
          },
        );
  }, [motion, scene, width, height]);
  return (
    <div
      aria-hidden
      className={`glass-scene cursor-layer${scene.reducedMotion ? " cursor-layer--still" : ""}`}
      ref={motion.layerRef}
    >
      <BrowserCropCue
        mounted
        croppedRight={scene.croppedRight}
        croppedBottom={scene.croppedBottom}
      />
      {scene.cursors.map((cursor) => (
        <CursorMark
          color={taskCursorPaint(taskMark(cursor), cursor.home)}
          icon={cursor.home ? null : taskMark(cursor).icon}
          id={cursor.threadId}
          key={cursor.threadId}
          motion={motion}
          title={cursor.title}
        />
      ))}
    </div>
  );
}
