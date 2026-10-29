// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MacOSSigning",
  platforms: [.macOS(.v14)],
  products: [.library(name: "MacOSSigning", targets: ["MacOSSigning"])],
  targets: [.target(name: "MacOSSigning")]
)
