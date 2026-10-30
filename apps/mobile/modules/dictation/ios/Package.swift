// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "DictationLifecycle", platforms: [.macOS(.v14), .iOS("16.4")], products: [.library(name: "DictationLifecycle", targets: ["DictationLifecycle"])], targets: [.target(name: "DictationLifecycle"), .testTarget(name: "DictationLifecycleTests", dependencies: ["DictationLifecycle"])])
