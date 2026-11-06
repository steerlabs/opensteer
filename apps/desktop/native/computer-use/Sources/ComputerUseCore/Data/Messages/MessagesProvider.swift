import Foundation
import OpensteerAppleData

/// Messages on this Mac: the history read from `chat.db` under the helper's
/// Full Disk Access and Contacts grant, and sends made through the Messages app under its
/// Automation permission for Messages.
///
/// Reading and sending go two ways on purpose. `chat.db` is the only complete
/// history and is readable with nothing running; sending is the app's own
/// business, and a row written to the database is a message nobody delivers.
actor MessagesProvider: DataProvider {
  private let contacts: @Sendable (WorkBudget) throws -> [ContactRecord]
  private let databasePath: String
  private let clock: DataClock
  private let files: MessagesFiles
  private let automation: @Sendable () async -> DataGrantState
  private let outbox: MessagesOutbox

  /// `automation` is the definite answer a send needs, found without asking
  /// the person; `runOsascript` runs one script.
  init(
    databasePath: String = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Messages/chat.db").path,
    clock: DataClock = .mac,
    attachmentRoots: [URL]? = nil,
    stagingRoot: URL? = nil,
    contacts: @escaping @Sendable (WorkBudget) throws -> [ContactRecord] = {
      try ContactsStore.records(budget: $0)
    },
    automation: @escaping @Sendable () async -> DataGrantState = {
      await MessagesAutomation.shared.stateForSending()
    },
    runOsascript: (@Sendable (OsascriptRequest, WorkBudget) async throws -> OsascriptOutcome)? = nil
  ) {
    self.databasePath = databasePath
    self.clock = clock
    let home = FileManager.default.homeDirectoryForCurrentUser
    self.files = MessagesFiles(databasePath: databasePath,
      attachmentRoots: attachmentRoots ?? [URL(fileURLWithPath: databasePath).deletingLastPathComponent().appendingPathComponent("Attachments"), home.appendingPathComponent("Library/SMS/Attachments")],
      stagingRoot: stagingRoot ?? home.appendingPathComponent("Library/Messages/Attachments/opensteer"))
    self.contacts = contacts
    self.automation = automation
    self.outbox = runOsascript.map { MessagesOutbox(runWithBudget: $0) } ?? .shared
  }

  func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    try await invoke(operation: operation, arguments: arguments, scratchDirectory: nil, budget: budget)
  }

  func invoke(operation: String, arguments: [String: JSONValue], scratchDirectory: String?, budget: WorkBudget) async throws -> JSONValue {
    switch operation {
    case "query_messages":
      struct Arguments: Decodable { let sql: String }
      let args = try DataArguments.decode(Arguments.self, from: arguments)
      return try MessagesQuery(path: databasePath, clock: clock, contacts: { try self.contacts(budget) }).run(args.sql, budget: budget)
    case "export_attachment":
      struct Arguments: Decodable { let attachmentId: String }
      let args = try DataArguments.decode(Arguments.self, from: arguments)
      return try files.export(args.attachmentId, scratch: scratchDirectory, budget: budget)
    case "send_message":
      let args = try DataArguments.decode(MessagesSender.Arguments.self, from: arguments)
      _ = try MessagesSender.requests(args, staged: args.files ?? [])
      // Only ever a definite answer found without asking: an agent's send
      // never becomes the consent prompt in front of the person.
      switch await automation() {
      case .granted:
        break
      case .requestable, .denied:
        throw HelperError(.permissionRequired, DataPlane.permissionSentence(.automation))
      case .unknown:
        throw HelperError(.failed, "Messages could not be reached.")
      }
      let staged = try files.stage(args.files ?? [], scratch: scratchDirectory, budget: budget)
      let requests = try MessagesSender.requests(args, staged: staged)
      _ = try await outbox.run(requests, budget: budget)
      // Messages says it accepted the message, never that it arrived.
      return .object(["accepted": .bool(true)])
    default:
      throw HelperError(.unsupported, "This operation is not supported.")
    }
  }
}
