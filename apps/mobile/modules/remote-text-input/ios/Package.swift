// swift-tools-version: 5.9
import PackageDescription
#if os(macOS)
let coreExcludes = ["RemoteInputTextView.swift"]
let testExcludes = ["RemoteTextInputTests.swift"]
#else
let coreExcludes: [String] = []
let testExcludes: [String] = []
#endif
let package = Package(name: "RemoteTextInputCore", platforms: [.iOS(.v16)], products: [.library(name: "RemoteTextInputCore", targets: ["RemoteTextInputCore"])], targets: [.target(name: "RemoteTextInputCore", path: "Core", exclude: coreExcludes), .testTarget(name: "RemoteTextInputCoreTests", dependencies: ["RemoteTextInputCore"], path: "Tests", exclude: testExcludes)])
