import type { Session, WebContents } from "electron";
import type { DesktopAppOriginPolicy } from "./navigation-policy.js";
import type { DesktopUsbDeviceAccess } from "./usb-device-access.js";

export function configureDesktopPermissions(
  session: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  policy: DesktopAppOriginPolicy,
  usbDevices: Pick<DesktopUsbDeviceAccess, "permitsRequest"> | null,
  askMicrophone: () => Promise<boolean>,
): void {
  const ownPage = (contents: WebContents | null, mainFrame: boolean, url: string) =>
    contents !== null &&
    !contents.isDestroyed() &&
    mainFrame &&
    policy.allowsNavigation(contents.getURL()) &&
    policy.allowsNavigation(url);
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission === "usb") return usbDevices?.permitsRequest(origin) ?? false;
    return (
      permission === "media" &&
      details.mediaType === "audio" &&
      policy.isAppOrigin(origin) &&
      ownPage(contents, details.isMainFrame, details.requestingUrl ?? "")
    );
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (
      permission !== "media" ||
      !("mediaTypes" in details) ||
      details.mediaTypes?.length !== 1 ||
      details.mediaTypes[0] !== "audio" ||
      !ownPage(contents, details.isMainFrame, details.requestingUrl) ||
      !("securityOrigin" in details) ||
      !policy.isAppOrigin(details.securityOrigin ?? "")
    ) {
      callback(false);
      return;
    }
    // Consent may outlive navigation or renderer destruction.
    void askMicrophone().then(
      (granted) =>
        callback(granted && ownPage(contents, details.isMainFrame, details.requestingUrl)),
      () => callback(false),
    );
  });
}
