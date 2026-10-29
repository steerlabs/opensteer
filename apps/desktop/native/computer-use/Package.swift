// swift-tools-version: 5.9
import PackageDescription

/// `Opensteer Computer Use.app` — the only process on the Mac that holds the
/// Accessibility and Screen Recording grants (docs/computer-use.md §1).
///
/// The helper and shared Apple data package are signed into one executable.
/// Its designated requirement is what the desktop app trusts, so every byte
/// of the shared provider is reviewed with the helper.
///
/// Swift 5 language mode with complete strict-concurrency *diagnostics*: the
/// AppKit, Accessibility and CoreGraphics surfaces this helper lives on are
/// pre-concurrency C APIs, so Swift 6 mode turns their unavoidable global state
/// into errors. The warnings still hold the Swift code to the same rule.
let strictConcurrency: [SwiftSetting] = [
  .unsafeFlags(["-strict-concurrency=complete"])
]

let package = Package(
  name: "ComputerUse",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "ComputerUseCore", targets: ["ComputerUseCore"]),
    .executable(name: "ComputerUseHelper", targets: ["ComputerUseHelper"]),
    .executable(name: "PeerVerificationFixture", targets: ["PeerVerificationFixture"]),
  ],
  dependencies: [.package(path: "../../../../packages/apple-data"), .package(path: "../../../../packages/macos-signing")],
  targets: [
    .target(
      name: "ComputerUseCore",
      dependencies: [.product(name: "OpensteerAppleData", package: "apple-data"), .product(name: "MacOSSigning", package: "macos-signing")],
      path: "Sources/ComputerUseCore",
      swiftSettings: strictConcurrency
    ),
    .executableTarget(
      name: "ComputerUseHelper",
      dependencies: ["ComputerUseCore"],
      path: "Sources/ComputerUseHelper",
      swiftSettings: strictConcurrency
    ),
    .target(
      name: "ComputerUseTestSupport",
      dependencies: ["ComputerUseCore"],
      path: "Tests/ComputerUseTestSupport",
      swiftSettings: strictConcurrency
    ),
    .executableTarget(
      name: "PeerVerificationFixture",
      dependencies: ["ComputerUseCore", .product(name: "MacOSSigning", package: "macos-signing")],
      path: "Tests/Fixtures/PeerVerification",
      swiftSettings: strictConcurrency
    ),
    // Host-safe logic only: no windows, live AX/input, activation or subprocess automation.
    .testTarget(
      name: "ComputerUseCoreTests",
      dependencies: ["ComputerUseCore", "ComputerUseTestSupport", .product(name: "OpensteerAppleData", package: "apple-data")],
      path: "Tests/ComputerUseCoreTests",
      swiftSettings: strictConcurrency
    ),
    // Window-server, AppKit window, live process, focus and input tests run only in the VM.
    .testTarget(
      name: "ComputerUseLiveTests",
      dependencies: ["ComputerUseCore", "ComputerUseTestSupport", .product(name: "OpensteerAppleData", package: "apple-data")],
      path: "Tests/ComputerUseLiveTests",
      swiftSettings: strictConcurrency
    ),
  ]
)
