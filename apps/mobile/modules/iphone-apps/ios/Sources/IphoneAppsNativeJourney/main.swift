import CryptoKit
import Foundation
import IphoneAppsCore
import OpensteerAppleData

// A line-oriented adapter for the real Host/PostgreSQL VM journey. The OS
// Calendar, Location and Photos ports are explicitly fake. Location/Photos
// providers, proofs, wire frames, admission and dispatch are production code;
// this journey does not exercise CoreLocation, PhotoKit or iOS permission UI.
private actor FakeCalendarPort: DataProvider {
  private var events: [[String: Any]] = []
  private var saves = 0
  func count() -> Int { saves }
  func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue {
    switch operation {
    case "list_calendars":
      return try jsonValue(["calendars": [["account": NSNull(), "id": "vm-calendar",
        "isDefault": true, "title": "VM fake calendar", "writable": true]]])
    case "list_events":
      let parsed = try DataArguments.decode(ListEventsArguments.self, from: arguments)
      let window = try CalendarEvents.window(parsed, clock: .iphone)
      let selected = events.filter { record in
        guard let time = record["time"] as? Date, let title = record["title"] as? String else { return false }
        return window.contains(time) && (parsed.query == nil || title.localizedCaseInsensitiveContains(parsed.query!))
      }.map { $0["view"]! }
      return try jsonValue(["events": selected, "nextCursor": NSNull()])
    case "create_event":
      let parsed = try DataArguments.decode(CreateEventArguments.self, from: arguments)
      let fields = try CalendarEvents.fields(creating: parsed, clock: .iphone)
      try budget.startWrite()
      saves += 1
      let identifier = EventId(identifier: "vm-event-\(saves)", start: fields.start).text
      let view: [String: Any] = [
        "allDay": fields.allDay, "attendees": [String](), "calendarId": "vm-calendar",
        "end": DataClock.iphone.text(fields.end), "id": identifier,
        "location": fields.location ?? NSNull(), "notes": fields.notes ?? NSNull(),
        "notesTruncated": false, "recurring": false,
        "start": DataClock.iphone.text(fields.start), "status": "confirmed",
        "timeZone": NSNull(), "title": fields.title, "url": fields.url ?? NSNull(),
      ]
      events.append(["time": fields.start, "title": fields.title, "view": view])
      return try jsonValue(["event": view])
    default:
      throw HelperError(.unsupported, "The fake OS port serves Calendar list and create only.")
    }
  }
}

@MainActor
private final class FakeLocationPort: IphoneLocationPort {
  let permission = IphonePermission.granted
  let precise = false
  let foreground = true
  let cachedLocation: IphoneLocationFix? = nil
  var onChange: (@MainActor @Sendable (IphoneLocationEvent) -> Void)?
  private(set) var starts = 0
  private(set) var stops = 0

  func startUpdating() {
    starts += 1
    onChange?(.fixes([IphoneLocationFix(latitude: 40.7128, longitude: -74.006,
      horizontalAccuracyMeters: 120, capturedAt: Date())]))
  }
  func stopUpdating() { stops += 1 }
}

private actor FakePhotosPort: IphonePhotosStorePort {
  private var assetFetches = 0
  private let asset = IphonePhotoAsset(id: "vm-selected-photo",
    createdAt: Date(timeIntervalSince1970: 1_893_492_000),
    modifiedAt: Date(timeIntervalSince1970: 1_893_578_400),
    mediaKind: "image", width: 1200, height: 800, durationSeconds: nil, favorite: true)

  func permission() -> IphonePermission { .limited }
  func count() -> Int { assetFetches }
  func assetGroup(filters: IphonePhotosFilters, date: Date?, inclusive: Bool,
    undated: Bool, budget: WorkBudget) throws -> [IphonePhotoAsset] {
    try Task.checkCancellation()
    try budget.check()
    assetFetches += 1
    guard !undated, let created = asset.createdAt else { return [] }
    if let date, inclusive ? created > date : created >= date { return [] }
    if let after = filters.createdAfter, created <= after { return [] }
    if let before = filters.createdBefore, created >= before { return [] }
    guard filters.albumId == nil,
      filters.mediaKinds.isEmpty || filters.mediaKinds.contains(asset.mediaKind) else { return [] }
    return [asset]
  }
  func albums(afterTitle: String?, afterId: String?, limit: Int,
    budget: WorkBudget) throws -> [IphonePhotoAlbum] {
    throw HelperError(.unsupported, "The fake Photos OS port serves asset metadata only.")
  }
}

private func jsonValue(_ object: Any) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
}

private func required(_ object: [String: Any], _ key: String) throws -> String {
  try WireField.string(object, key)
}

private func seed(_ hex: String) throws -> Data {
  let chars = Array(hex)
  guard chars.count == 64 else { throw IphoneWireError.invalid("seed") }
  return try Data(stride(from: 0, to: 64, by: 2).map { offset in
    guard let byte = UInt8(String(chars[offset...offset + 1]), radix: 16) else {
      throw IphoneWireError.invalid("seed")
    }
    return byte
  })
}

private func iso(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

private final class WorkRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var counts: [Int] = []
  func record(_ count: Int) { lock.lock(); counts.append(count); lock.unlock() }
  func snapshot() -> [Int] { lock.lock(); defer { lock.unlock() }; return counts }
}

@MainActor
private final class Journey {
  private let clock = SystemContinuousClock()
  private let calendar = FakeCalendarPort()
  private let location = FakeLocationPort()
  private let photos = FakePhotosPort()
  private let work = WorkRecorder()
  private var runnerKey: Curve25519.Signing.PrivateKey?
  private var descriptor: [String: Any] = [:]
  private var enrollmentToken: String?
  private var gate: AdmissionGate?
  private var dispatch: IphoneDispatch?
  private var primary: PrimaryFence?
  private var auxiliary: AuxiliaryFence?
  private var ticket: String?
  private var dropNextAnswer = false

  func call(_ input: [String: Any]) async throws -> [String: Any] {
    let command = try required(input, "command")
    switch command {
    case "start":
      runnerKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed(required(input, "runnerSeed")))
      descriptor = try WireField.object(input, "descriptor")
      enrollmentToken = try required(input, "enrollmentToken")
      let authority = AdmissionGate(runnerId: try required(descriptor, "runnerId"),
        bootId: try required(descriptor, "bootId"), clock: clock)
      authority.activate()
      gate = authority
      dispatch = IphoneDispatch(gate: authority, clock: clock, providers: [
        "apple-calendar": calendar,
        "iphone-location": IphoneLocationProvider(store: location, deviceName: "VM fake iPhone"),
        "iphone-photos": IphonePhotosProvider(store: photos),
      ],
        onWorkChange: { [work] in work.record(authority.inFlight) })
      return ["kind": "started", "runnerId": try required(descriptor, "runnerId")]
    case "primary":
      return try handlePrimary(WireField.object(input, "frame"))
    case "auxiliary":
      return await handleAuxiliary(try WireField.object(input, "frame"))
    case "heartbeat":
      guard let primary, let auxiliary else { throw IphoneWireError.invalid("connection") }
      let sentAt = iso(Date())
      return ["kind": "frames", "frames": [
        ["channel": "primary", "frame": IphoneWire.heartbeat(primary, sentAt: sentAt)],
        ["channel": "auxiliary", "frame": IphoneWire.auxiliaryHeartbeat(auxiliary, sentAt: sentAt)],
      ]]
    case "drop-next-answer": dropNextAnswer = true; return ["kind": "armed"]
    case "snapshot": return ["kind": "snapshot", "fakeCalendarSaveCount": await calendar.count(),
      "workTransitions": work.snapshot(), "fakeLocationStarts": location.starts,
      "fakeLocationStops": location.stops, "fakePhotosAssetFetches": await photos.count()]
    case "background": gate?.background(); return ["kind": "background"]
    case "expire": gate?.expireBackground(); return ["kind": "expired"]
    case "transport-lost":
      if let gate { gate.detach(generation: gate.generation) }
      return ["kind": "detached"]
    case "resume":
      guard let gate else { throw IphoneWireError.invalid("identity") }
      gate.activate()
      primary = nil; auxiliary = nil; ticket = nil; enrollmentToken = nil
      dropNextAnswer = false
      return ["kind": "resumed"]
    case "disconnect": gate?.disconnect(); return ["kind": "disconnected"]
    default: throw IphoneWireError.unexpected(command)
    }
  }

  private func handlePrimary(_ frame: [String: Any]) throws -> [String: Any] {
    let type = try required(frame, "type")
    guard let runnerKey else { throw IphoneWireError.invalid("identity") }
    switch type {
    case "host.challenge":
      let challenge = try IphoneWire.challenge(frame)
      return ["kind": "frame", "channel": "primary",
        "frame": try IphoneWire.authenticateFrame(challenge: challenge, descriptor: descriptor,
          key: runnerKey, token: enrollmentToken)]
    case "host.welcome":
      let welcome = try IphoneWire.primaryWelcome(frame,
        runnerId: required(descriptor, "runnerId"), bootId: required(descriptor, "bootId"))
      primary = welcome.fence
      enrollmentToken = nil
      return ["kind": "frame", "channel": "primary", "frame": IphoneWire.ticketRequest(
        welcome.fence, requestId: "aux:iphone-native-journey")]
    case "host.auxiliary.ticket":
      guard let primary, try PrimaryFence(frame) == primary else { throw IphoneWireError.staleFence }
      ticket = try required(frame, "ticket")
      return ["kind": "ticket", "ticket": ticket!]
    case "host.connection.lease-renewed":
      guard let primary, try PrimaryFence(frame) == primary else { throw IphoneWireError.staleFence }
      return ["kind": "renewed"]
    default: throw IphoneWireError.unexpected(type)
    }
  }

  private func handleAuxiliary(_ frame: [String: Any]) async -> [String: Any] {
    do {
      let type = try required(frame, "type")
      switch type {
      case "host.auxiliary.challenge":
        guard let runnerKey, let ticket else { throw IphoneWireError.invalid("ticket") }
        let challenge = try IphoneWire.challenge(frame, auxiliary: true)
        return ["kind": "frame", "channel": "auxiliary", "frame": try IphoneWire.auxiliaryAuthenticateFrame(
          challenge: challenge, key: runnerKey, runnerId: required(descriptor, "runnerId"),
          bootId: required(descriptor, "bootId"), ticket: ticket)]
      case "host.auxiliary.welcome":
        guard let primary else { throw IphoneWireError.invalid("primary") }
        let welcome = try IphoneWire.auxiliaryWelcome(frame, primary: primary)
        auxiliary = welcome.fence
        gate?.attach(fence: welcome.fence.tag,
          leaseSeconds: UInt64(max(0, welcome.leaseExpiresAt.timeIntervalSince(welcome.serverTime))))
        let sentAt = iso(Date())
        return ["kind": "frames", "frames": [
          ["channel": "primary", "frame": IphoneWire.modulesReport(primary, checkedAt: sentAt)],
          ["channel": "auxiliary", "frame": IphoneWire.status(welcome.fence,
            permissions: ["apple-calendar": .granted, "apple-contacts": .denied, "apple-reminders": .denied,
              "iphone-location": .granted, "iphone-photos": .limited], locationAccuracy: location.precise ? "precise" : "approximate")],
        ]]
      case "host.auxiliary.lease-renewed":
        guard let auxiliary, try AuxiliaryFence(frame) == auxiliary else { throw IphoneWireError.staleFence }
        let expiry = try WireField.date(frame, "streamLeaseExpiresAt")
        guard gate?.renew(fence: auxiliary.tag, leaseSeconds: UInt64(max(0, expiry.timeIntervalSinceNow))) == true else {
          throw IphoneWireError.invalid("lease")
        }
        return ["kind": "renewed"]
      case "host.integrations.invoke":
        guard let auxiliary, let dispatch else { throw IphoneWireError.invalid("stream") }
        let result = await dispatch.run(frame, fence: auxiliary, receivedAt: clock.now(),
          permission: frame["definitionId"] as? String == "iphone-photos" ? .limited : .granted,
          deviceName: "VM fake iPhone")
        if dropNextAnswer { dropNextAnswer = false; return ["kind": "answer-dropped"] }
        guard let result else { return ["kind": "no-answer"] }
        return ["kind": "frame", "channel": "auxiliary", "frame": result]
      case "host.integrations.cancel":
        dispatch?.cancel(try required(frame, "requestId"))
        return ["kind": "cancelled"]
      default: throw IphoneWireError.unexpected(type)
      }
    } catch { return ["kind": "error", "message": "\(error)"] }
  }
}

@main private struct NativeJourney {
  @MainActor static func main() async {
    let journey = Journey()
    while let line = readLine() {
      do {
        let bytes = Data(line.utf8)
        guard let command = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
          throw IphoneWireError.invalid("command")
        }
        let result = try await journey.call(command)
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result) + Data([10]))
      } catch {
        let result = ["kind": "error", "message": "\(error)"]
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          FileHandle.standardOutput.write(data + Data([10]))
        }
      }
    }
  }
}
