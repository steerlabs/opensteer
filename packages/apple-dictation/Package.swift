// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "OpensteerDictation",
  platforms: [.macOS(.v14), .iOS("16.4")],
  products: [.library(name: "OpensteerDictation", targets: ["OpensteerDictation"])],
  targets: [.target(name: "OpensteerDictation"),
            .testTarget(name: "OpensteerDictationTests", dependencies: ["OpensteerDictation"])]
)
