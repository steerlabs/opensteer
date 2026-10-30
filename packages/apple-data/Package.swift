// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpensteerAppleData",
  platforms: [.macOS(.v14), .iOS("16.4")],
  products: [.library(name: "OpensteerAppleData", targets: ["OpensteerAppleData"])],
  targets: [
    .target(name: "OpensteerAppleData", path: "Sources/OpensteerAppleData", resources: [.embedInCode("Resources/contracts.json")]),
    .testTarget(name: "OpensteerAppleDataTests", dependencies: ["OpensteerAppleData"]),
  ]
)
