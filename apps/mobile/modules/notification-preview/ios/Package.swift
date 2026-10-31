// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "NotificationPreview", platforms: [.macOS(.v13), .iOS(.v16)],
  products: [.library(name: "NotificationPreview", targets: ["NotificationPreview"])],
  targets: [
    .target(name: "NotificationPreview", exclude: ["KeyStore.swift"]),
    .testTarget(name: "NotificationPreviewTests", dependencies: ["NotificationPreview"]),
  ])
