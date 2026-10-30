// swift-tools-version: 5.9
import PackageDescription
let package = Package(
 name: "DictationHelper", platforms: [.macOS(.v14)],
 products: [.executable(name: "DictationHelper", targets: ["DictationHelper"])],
 dependencies: [.package(path: "../../../../packages/apple-dictation"), .package(path: "../../../../packages/macos-signing")],
 targets: [
  .target(name: "DictationHelperKit", dependencies: [.product(name: "OpensteerDictation", package: "apple-dictation"), .product(name: "MacOSSigning", package: "macos-signing")]),
  .executableTarget(name: "DictationHelper", dependencies: ["DictationHelperKit"]),
  .testTarget(name: "DictationHelperTests", dependencies: ["DictationHelperKit"]),
 ])
