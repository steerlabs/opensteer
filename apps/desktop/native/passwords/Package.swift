// swift-tools-version: 5.9
import PackageDescription

/// Opensteer Passwords: the credential broker app, its sandboxed import
/// worker, and the vault, crypto and import code both build on.
///
/// No external dependencies on purpose: the broker holds the owner keys and
/// every byte that can see a password is reviewed here. `PasswordsCore` is
/// pure (Foundation, CryptoKit, Security, LocalAuthentication) so it can be
/// tested without the app. `PasswordsBrokerKit` is the broker itself (socket,
/// transactions, grants, the authentication policy, the window); the
/// `PasswordsBroker` executable derives its authority from its own signature.
/// Same-user development trust requires an explicit Swift compilation condition.
///
/// Swift 5 language mode with complete strict-concurrency diagnostics, as in
/// the computer-use helper: AppKit, LocalAuthentication and Security are
/// pre-concurrency APIs.
let strictConcurrency: [SwiftSetting] = [
  .unsafeFlags(["-strict-concurrency=complete"])
]

let package = Package(
  name: "Passwords",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "PasswordsCore", targets: ["PasswordsCore"]),
    .executable(name: "PasswordsBroker", targets: ["PasswordsBroker"]),
    .executable(name: "PasswordsImportWorker", targets: ["PasswordsImportWorker"]),
  ],
  dependencies: [.package(path: "../../../../packages/macos-signing")],
  targets: [
    .target(
      name: "PasswordsCore",
      path: "Sources/PasswordsCore",
      // Compiled into the code: the hand-assembled app has no SwiftPM
      // resource bundle for `Bundle.module` to find.
      resources: [.embedInCode("Resources/public_suffix_list.dat")],
      swiftSettings: strictConcurrency
    ),
    .target(
      name: "PasswordsBrokerKit",
      dependencies: ["PasswordsCore", .product(name: "MacOSSigning", package: "macos-signing")],
      path: "Sources/PasswordsBrokerKit",
      swiftSettings: strictConcurrency
    ),
    .executableTarget(
      name: "PasswordsBroker",
      dependencies: ["PasswordsBrokerKit"],
      path: "Sources/PasswordsBroker",
      swiftSettings: strictConcurrency
    ),
    .executableTarget(
      name: "PasswordsImportWorker",
      dependencies: ["PasswordsCore"],
      path: "Sources/PasswordsImportWorker",
      exclude: ["Info.plist", "Info.development.plist"],
      swiftSettings: strictConcurrency,
      // Sandbox identity follows the build configuration; no environment value
      // may select development metadata for a release worker.
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
          "-Xlinker", Context.packageDirectory + "/Sources/PasswordsImportWorker/Info.plist",
        ], .when(configuration: .release)),
        .unsafeFlags([
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
          "-Xlinker", Context.packageDirectory + "/Sources/PasswordsImportWorker/Info.development.plist",
        ], .when(configuration: .debug)),
      ]
    ),
    // Test-only owner keys and sessions; no product or executable links it.
    .target(
      name: "PasswordsTestSupport",
      dependencies: ["PasswordsCore"],
      path: "Tests/PasswordsTestSupport",
      swiftSettings: strictConcurrency
    ),
    .testTarget(
      name: "PasswordsCoreTests",
      dependencies: ["PasswordsCore", "PasswordsTestSupport"],
      path: "Tests/PasswordsCoreTests",
      resources: [.copy("Fixtures")],
      swiftSettings: strictConcurrency
    ),
    .testTarget(
      name: "PasswordsBrokerTests",
      dependencies: ["PasswordsBrokerKit", "PasswordsTestSupport", "PasswordsImportWorker"],
      path: "Tests/PasswordsBrokerTests",
      swiftSettings: strictConcurrency
    ),
  ]
)
