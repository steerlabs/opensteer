// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "PhoneDisplayCore", platforms: [.macOS(.v14), .iOS("16.4")], products: [.library(name: "PhoneDisplayCore", targets: ["PhoneDisplayCore"])], targets: [.target(name: "PhoneDisplayCore", path: "Core"), .testTarget(name: "PhoneDisplayCoreTests", dependencies: ["PhoneDisplayCore"], path: "Tests")])
