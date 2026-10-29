import Foundation

/// Messages on this Mac: the history read from `chat.db` under the helper's
/// Full Disk Access, and sends made through the Messages app under its
/// Automation permission for Messages.
///
/// Reading and sending go two ways on purpose. `chat.db` is the only complete
/// history and is readable with nothing running; sending is the app's own
/// business, and a row written to the database is a message nobody delivers.
actor MessagesProvider: DataProvider {
  /// A search stops this long before its request's deadline, so its page and
  /// cursor still reach the agent.
  private static let searchMargin: TimeInterval = 2

  private let reader: MessagesReader
  private let automation: @Sendable () async -> DataGrantState
  private let runOsascript: @Sendable (OsascriptRequest, WorkBudget) async throws -> OsascriptOutcome

  /// `automation` is the definite answer a send needs, found without asking
  /// the person; `runOsascript` runs one script.
  init(
    databasePath: String = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Messages/chat.db").path,
    clock: DataClock = .mac,
    automation: @escaping @Sendable () async -> DataGrantState = {
      await MessagesAutomation.shared.stateForSending()
    },
    runOsascript: @escaping @Sendable (OsascriptRequest, WorkBudget) async throws
      -> OsascriptOutcome = { try await MessagesOutbox.shared.run($0, budget: $1) }
  ) {
    self.reader = MessagesReader(path: databasePath, clock: clock)
    self.automation = automation
    self.runOsascript = runOsascript
  }

  func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    switch operation {
    case "list_conversations":
      return try JSONValue(
        encoding: reader.listConversations(
          DataArguments.decode(ListConversationsArguments.self, from: arguments)))
    case "read_messages":
      return try JSONValue(
        encoding: reader.readMessages(
          DataArguments.decode(ReadMessagesArguments.self, from: arguments),
          timeLeft: { budget.remaining() - Self.searchMargin }))
    case "send_message":
      let request = try MessagesSender.request(
        DataArguments.decode(MessagesSender.Arguments.self, from: arguments))
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
      try budget.startWrite()
      let outcome = try await runOsascript(request, budget)
      try MessagesSender.check(outcome)
      // Messages says it accepted the message, never that it arrived.
      return .object(["accepted": .bool(true)])
    default:
      throw HelperError(.unsupported, "This operation is not supported.")
    }
  }
}
