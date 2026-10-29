import Foundation

public enum DataEffect: String, Codable, Sendable {
  case read, write
}

public enum DataAccess: String, Codable, Sendable {
  case read
  case readWrite = "read-write"
}

public struct DataOperationContract: Codable, Sendable, Equatable {
  public let contract: String
  public let effect: DataEffect
  public init(contract: String, effect: DataEffect) {
    self.contract = contract
    self.effect = effect
  }
}

public enum DataGrant: String, Codable, Sendable, CaseIterable {
  case automation, calendars, contacts, reminders
  case fullDiskAccess = "full-disk-access"
}

public enum DataGrantState: String, Codable, Sendable {
  case granted, requestable, denied, unknown
}

public struct DataAppGrants: Codable, Sendable, Equatable {
  public let read: DataGrant
  public let write: DataGrant
  public init(read: DataGrant, write: DataGrant) {
    self.read = read
    self.write = write
  }
}

public protocol DataProvider: Sendable {
  func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue
}

public struct WorkBudget: Sendable, Equatable {
  public let batchEnd: Date?
  public let requestEnd: Date?
  private let writeStart: (@Sendable () throws -> Void)?
  public init(batchEnd: Date? = nil, requestEnd: Date? = nil, writeStart: (@Sendable () throws -> Void)? = nil) {
    self.batchEnd = batchEnd
    self.requestEnd = requestEnd
    self.writeStart = writeStart
  }
  public static func == (left: WorkBudget, right: WorkBudget) -> Bool {
    left.batchEnd == right.batchEnd && left.requestEnd == right.requestEnd
  }
  public static let unlimited = WorkBudget()
  public static let batchExpired = HelperError(.failed, "This batch ran out of its thirty seconds; ask for fewer actions at a time.")
  public static let requestExpired = HelperError(.failed, "This request ran out of time, so the work stopped where it was; read the new observation before continuing.")
  public var end: Date? {
    switch (batchEnd, requestEnd) {
    case (let batch?, let request?): return min(batch, request)
    case (let batch?, nil): return batch
    case (nil, let request?): return request
    case (nil, nil): return nil
    }
  }
  public func remaining(now: Date = Date()) -> TimeInterval {
    guard let end else { return .infinity }
    return end.timeIntervalSince(now)
  }
  public var requestExpiredNow: Bool {
    guard let requestEnd else { return false }
    return Date() >= requestEnd
  }
  public func check(now: Date = Date()) throws {
    if let requestEnd, now >= requestEnd, requestEnd <= (batchEnd ?? .distantFuture) { throw Self.requestExpired }
    if let batchEnd, now >= batchEnd { throw Self.batchExpired }
    if let requestEnd, now >= requestEnd { throw Self.requestExpired }
  }
  public func startingBatch(_ length: TimeInterval, now: Date = Date()) -> WorkBudget {
    WorkBudget(batchEnd: now.addingTimeInterval(length), requestEnd: requestEnd, writeStart: writeStart)
  }
  public func startWrite() throws {
    guard remaining() > 0 else { throw HelperError(.failed, "The request ran out of time before anything was changed.") }
    try writeStart?()
  }
}
