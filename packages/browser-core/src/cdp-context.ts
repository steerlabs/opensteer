/** CDP parameters that select a browser context; routing supplies the admitted profile. */
export const contextScopedCdpMethods: ReadonlySet<string> = new Set([
  "Browser.setPermission",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
  "Browser.cancelDownload",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
]);
