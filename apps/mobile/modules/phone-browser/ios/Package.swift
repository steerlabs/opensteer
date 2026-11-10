// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PhoneBrowserCore",
  platforms: [.macOS(.v14), .iOS("16.4")],
  products: [.library(name: "PhoneBrowserCore", targets: ["PhoneBrowserCore"])],
  targets: [
    .target(name: "PhoneBrowserCore", path: "Core"),
    .testTarget(name: "PhoneBrowserCoreTests", dependencies: ["PhoneBrowserCore"], path: "Tests"),
  ]
)
