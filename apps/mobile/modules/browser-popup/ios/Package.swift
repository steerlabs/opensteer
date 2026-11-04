// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BrowserPopupCore", platforms: [.macOS(.v14), .iOS("16.4")], products: [.library(name: "BrowserPopupCore", targets: ["BrowserPopupCore"])], targets: [.target(name: "BrowserPopupCore", path: "Core"), .testTarget(name: "BrowserPopupCoreTests", dependencies: ["BrowserPopupCore"], path: "Tests")])
