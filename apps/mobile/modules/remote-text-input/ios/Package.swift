// swift-tools-version: 5.9
import PackageDescription
// The UIKit view and its tests guard themselves with `#if canImport(UIKit)`: a manifest condition
// is decided by the host, so excluding them here left them out of iOS Simulator builds as well.
let package = Package(name: "RemoteTextInputCore", platforms: [.iOS(.v16)], products: [.library(name: "RemoteTextInputCore", targets: ["RemoteTextInputCore"])], targets: [.target(name: "RemoteTextInputCore", path: "Core"), .testTarget(name: "RemoteTextInputCoreTests", dependencies: ["RemoteTextInputCore"], path: "Tests")])
