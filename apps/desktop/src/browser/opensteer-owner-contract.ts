// The patched Electron reports its private owner contract through
// `electron_vendor_version`; stock Electron has none. Match the contract exactly.
export const opensteerOwnerAvailable = process.versions["opensteer"] === "1";
