// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "RemoteTextInputCore", platforms: [.iOS(.v16)], products: [.library(name: "RemoteTextInputCore", targets: ["RemoteTextInputCore"])], targets: [.target(name: "RemoteTextInputCore", path: "Core"), .testTarget(name: "RemoteTextInputCoreTests", dependencies: ["RemoteTextInputCore"], path: "Tests")])
