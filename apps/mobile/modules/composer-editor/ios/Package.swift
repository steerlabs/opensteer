// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ComposerEditorCore",
  platforms: [.macOS(.v14), .iOS("16.4")],
  products: [.library(name: "ComposerEditorCore", targets: ["ComposerEditorCore"])],
  targets: [
    .target(name: "ComposerEditorCore", path: "Core"),
    .testTarget(name: "ComposerEditorCoreTests", dependencies: ["ComposerEditorCore"], path: "Tests"),
  ]
)
