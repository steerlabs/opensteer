import { app, dialog } from "electron";
import type { ShutdownLog } from "./desktop-shutdown.js";

/** Called after the instance lock and before admitting supervised children. */
export async function offerMoveToApplications(log: ShutdownLog): Promise<boolean> {
  if (!app.isPackaged || process.platform !== "darwin" || app.isInApplicationsFolder())
    return false;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Move Opensteer to the Applications folder?",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (conflict) => {
        if (conflict === "existsAndRunning") {
          dialog.showMessageBoxSync({
            type: "info",
            message:
              "Opensteer is already running in Applications. Quit that copy before moving this one.",
            buttons: ["OK"],
          });
          return false;
        }
        return (
          dialog.showMessageBoxSync({
            type: "question",
            message: "Replace the existing Opensteer in Applications?",
            buttons: ["Cancel", "Replace"],
            defaultId: 0,
            cancelId: 0,
          }) === 1
        );
      },
    });
  } catch {
    log("desktop.move-to-applications.failed", {});
    dialog.showMessageBoxSync({
      type: "info",
      message: "Opensteer could not move to Applications. You can move it there using Finder.",
      buttons: ["OK"],
    });
    return false;
  }
}
