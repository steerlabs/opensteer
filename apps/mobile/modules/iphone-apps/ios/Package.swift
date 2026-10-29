// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "IphoneAppsCore",
  platforms: [.macOS(.v14), .iOS("16.4")],
  products: [.library(name: "IphoneAppsCore", targets: ["IphoneAppsCore"]),
    .executable(name: "IphoneAppsVectors", targets: ["IphoneAppsVectors"]),
    .executable(name: "IphoneAppsNativeJourney", targets: ["IphoneAppsNativeJourney"])],
  dependencies: [.package(path: "../../../../../packages/apple-data")],
  targets: [
    .target(name: "IphoneAppsCore", dependencies: [
      .product(name: "OpensteerAppleData", package: "apple-data"),
    ], path: "Sources/IphoneAppsCore"),
    .executableTarget(name: "IphoneAppsVectors", dependencies: ["IphoneAppsCore"], path: "Sources/IphoneAppsVectors"),
    .executableTarget(name: "IphoneAppsNativeJourney", dependencies: ["IphoneAppsCore",
      .product(name: "OpensteerAppleData", package: "apple-data")], path: "Sources/IphoneAppsNativeJourney"),
    .testTarget(name: "IphoneAppsCoreTests", dependencies: [
      "IphoneAppsCore", .product(name: "OpensteerAppleData", package: "apple-data"),
    ], path: "Tests/IphoneAppsCoreTests"),
  ]
)
