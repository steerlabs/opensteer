@testable import OpensteerAppleData
import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// `Tests/Fixtures/helper-wire.json` — one realistic frame body per method,
/// per event, the action request, and the error envelope, **encoded by
/// the helper's own wire values and result types**.
///
/// The protocol package parses every entry with the matching zod schema, so
/// this file is the contract pinned from both sides: the Swift types cannot
/// change shape without rewriting it, and the schemas cannot change without the
/// parse failing. Regenerate with:
///
///     OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --filter HelperWireFixtureTests
final class HelperWireFixtureTests: XCTestCase {
  private static let sessionId = "cus_4a7c2f18-9b3e-4d61-8a02-5f6c1d9e0b74"
  private static let observationId = "9f2c41ab7e0d5638"

  /// A 2×2 all-white JPEG, encoded here rather than pasted, so the fixture's
  /// base64 is a picture a decoder actually accepts.
  @MainActor
  private static func tinyJPEGBase64() throws -> String {
    let width = 2
    let height = 2
    let context = try XCTUnwrap(
      CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    )
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let data = try XCTUnwrap(WindowCapture.encodeJPEG(image, quality: WindowCapture.primaryQuality))
    return data.base64EncodedString()
  }

  /// The fixture's own top level. Encoded by `JSONEncoder`, not built up as a
  /// dictionary of `Any` and re-serialised, so every number in the file is
  /// printed exactly as the helper prints it on the wire.
  private struct Fixture: Encodable {
    /// Every operation of every app the helper serves: the contract and
    /// effect this build compiled in, and an answer the helper's own rules
    /// wrote, for the protocol package to hold to the catalog.
    let apps: [String: [String: AppOperation]]
    let error: AnyEncodable
    let events: [String: AnyEncodable]
    let requests: [String: AnyEncodable]
    let results: [String: AnyEncodable]
  }

  private struct AppOperation: Encodable {
    let contract: String
    let effect: DataEffect
    let output: AnyEncodable
  }

  /// One answer per operation, from the same rules the providers answer with.
  private static func appOutputs() throws -> [String: [String: any Encodable]] {
    let clock = DataClock(timeZone: TimeZone(identifier: "America/Los_Angeles")!)
    let date = { (text: String) in ISO8601DateFormatter().date(from: text)! }
    let meeting = EventRecord(
      identifier: "6F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9:0F9E8D7C-6B5A-4938-2716-05F4E3D2C1B0",
      calendarId: "B7A1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D", title: "Design review",
      start: date("2026-10-01T16:00:00Z"), end: date("2026-10-01T17:00:00Z"), allDay: false,
      timeZone: "America/Los_Angeles", location: "Studio", notes: "Bring the prototype.",
      url: "https://meet.example.com/design", recurring: true, status: .confirmed,
      attendees: [
        AttendeeView(
          email: "ada@engines.example", isMe: true, name: "Ada Lovelace", status: .accepted),
        AttendeeView(email: nil, isMe: false, name: "Room 4", status: .unknown),
      ])
    let trip = EventRecord(
      identifier: "A1B2C3D4-E5F6-4789-9ABC-DEF012345678",
      calendarId: "B7A1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D",
      title: "Offsite", start: clock.startOfDay(DataDay(year: 2026, month: 10, day: 2)),
      end: clock.startOfDay(DataDay(year: 2026, month: 10, day: 4)).addingTimeInterval(-1),
      allDay: true, timeZone: nil, location: nil, notes: nil, url: nil, recurring: false,
      status: .tentative, attendees: [])
    let calendars = [
      ContainerView(
        account: "iCloud", id: "B7A1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D", isDefault: true,
        title: "Home", writable: true),
      ContainerView(
        account: nil, id: "0C1D2E3F-4A5B-4C6D-8E7F-9A0B1C2D3E4F", isDefault: false,
        title: "Holidays", writable: false),
    ]
    let reminder = ReminderRecord(
      id: "5D4C3B2A-1908-4F7E-9D6C-5B4A39281706", listId: "7E6D5C4B-3A29-4817-8F6E-5D4C3B2A1908",
      title: "Renew passport", notes: "Photos first", due: .instant(date("2026-10-05T16:00:00Z")),
      priority: 1, completed: false, completedAt: nil, url: nil, recurring: false)
    let done = ReminderRecord(
      id: "9A8B7C6D-5E4F-4321-8765-43210FEDCBA9", listId: "7E6D5C4B-3A29-4817-8F6E-5D4C3B2A1908",
      title: "Book flights", notes: nil, due: .day(DataDay(year: 2026, month: 9, day: 30)),
      priority: 0, completed: true, completedAt: date("2026-09-29T18:30:00Z"),
      url: "https://airline.example.com/booking", recurring: true)
    return [
      "apple-calendar": [
        "list_calendars": CalendarsResult(calendars: calendars),
        "list_events": try CalendarEvents.page(
          [meeting, trip],
          arguments: ListEventsArguments(
            calendarIds: nil, cursor: nil, end: "2026-10-03", limit: 1, query: nil,
            start: "2026-10-01"),
          clock: clock),
        "create_event": EventResult(event: CalendarEvents.view(trip, clock: clock)),
        "update_event": EventResult(event: CalendarEvents.view(meeting, clock: clock)),
        "delete_event": DeletedResult(),
      ],
      "apple-contacts": [
        "search_contacts": try Self.contactsPage()
      ],
      "apple-messages": [
        "list_conversations": ConversationsPage(
          conversations: [
            ConversationView(
              conversationId: "iMessage;+;chat483920", displayName: "Weekend Trip", isGroup: true,
              lastMessageAt: "2024-03-02T23:00:00-08:00",
              participants: ["+15551234567", "work@example.com"], service: "iMessage"),
            ConversationView(
              conversationId: "iMessage;-;work@example.com", displayName: nil, isGroup: false,
              lastMessageAt: nil, participants: ["work@example.com"], service: "iMessage"),
          ],
          nextCursor: nil),
        "read_messages": MessagesPage(
          messages: [
            MessageView(
              conversationId: "iMessage;-;+15551234567", hasAttachments: false,
              id: "8C5A1E2F-3B4D-4E6F-8A9B-0C1D2E3F4A5B", isFromMe: false, sender: "+15551234567",
              sentAt: "2024-03-01T02:00:00-08:00", service: "iMessage", text: "Lunch at one?",
              truncated: false, undecoded: false),
            MessageView(
              conversationId: "iMessage;-;+15551234567", hasAttachments: true,
              id: "1F2E3D4C-5B6A-4798-8A7B-6C5D4E3F2A1B", isFromMe: true, sender: "me",
              sentAt: "2024-03-01T01:55:00-08:00", service: "iMessage", text: nil,
              truncated: false, undecoded: true),
          ],
          nextCursor: "e3b0c44298fc1c149afbf4c8.759952500000000000.2"),
        "send_message": JSONValue.object(["accepted": .bool(true)]),
      ],
      "apple-reminders": [
        "list_reminder_lists": ReminderListsResult(
          lists: [
            ContainerView(
              account: "iCloud", id: "7E6D5C4B-3A29-4817-8F6E-5D4C3B2A1908", isDefault: true,
              title: "Reminders", writable: true)
          ]),
        "list_reminders": try Reminders.page(
          [reminder, done],
          arguments: ListRemindersArguments(
            cursor: nil, limit: 1, listIds: nil, query: nil, status: .incomplete),
          clock: clock),
        "create_reminder": ReminderResult(reminder: Reminders.view(reminder, clock: clock)),
        "update_reminder": ReminderResult(reminder: Reminders.view(done, clock: clock)),
        "delete_reminder": DeletedResult(),
      ],
    ]
  }

  private static func contactsPage() throws -> ContactsPage {
    try ContactsSearch.page(
      [
        ContactRecord(
          id: "410FE041-5C4E-48DA-B4DE-04C15EA3DBAC:ABPerson", name: "Ada Lovelace",
          organization: "Analytical Engines",
          emails: [LabeledText(label: "work", value: "ada@engines.example")],
          phones: [LabeledText(label: "mobile", value: "+1 (555) 123-4567")],
          birthday: DateComponents(year: 1815, month: 12, day: 10)),
        ContactRecord(
          id: "8E6B1F2A-0B9C-4B8D-9E2F-3A4B5C6D7E8F:ABPerson", name: nil,
          organization: "Acme Plumbing", emails: [], phones: [], birthday: nil),
      ],
      // Both, so the page shows a contact with nothing recorded and the end
      // of a listing, each written as null.
      arguments: ContactsSearchArguments(cursor: nil, limit: 2, query: nil))
  }

  /// Every compiled operation has its answer here, so an operation added to
  /// the catalog cannot reach the helper without one.
  private static func apps() throws -> [String: [String: AppOperation]] {
    let outputs = try appOutputs()
    var apps: [String: [String: AppOperation]] = [:]
    for (definitionId, operations) in DataContracts.operations {
      for (name, compiled) in operations {
        let output = try XCTUnwrap(
          outputs[definitionId]?[name], "\(definitionId).\(name) needs an answer in the fixture")
        apps[definitionId, default: [:]][name] = AppOperation(
          contract: compiled.contract, effect: compiled.effect, output: AnyEncodable(output))
      }
    }
    return apps
  }

  @MainActor
  private func fixture() throws -> Fixture {
    let notes = AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil)
    let chrome = AppIdentity(
      bundleId: "com.google.Chrome",
      displayName: "Google Chrome",
      teamId: "EQHXZ8M8AV"
    )
    let permissions = PermissionsState(accessibility: .granted, screenRecording: .granted)

    // A 900×620 point window on a 2× display, at the size the helper
    // delivers it, with the tree the helper's own walker and formatter write.
    let windowFrame = CGRect(x: 240, y: 118, width: 900, height: 620)
    let size = WindowCapture.targetSize(points: windowFrame.size, captureScale: 2)
    let coordinates = ObservationCoordinates(
      cropOrigin: .zero, scale: CGFloat(size.width) / windowFrame.width,
      geometry: Observation.Geometry(width: size.width, height: size.height))
    func at(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
      CGRect(x: windowFrame.minX + x, y: windowFrame.minY + y, width: width, height: height)
    }
    let window = FakeElementNode.node(
      "AXWindow", title: "Shopping list", frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXToolbar", frame: at(0, 0, 900, 52),
          children: [
            FakeElementNode.node("AXButton", title: "New Note", frame: at(12, 12, 96, 28)),
            FakeElementNode.node(
              "AXButton", title: "Delete", frame: at(120, 12, 72, 28), enabled: false),
          ]),
        FakeElementNode.node(
          "AXTextArea", value: "Milk, eggs, bread", frame: at(220, 64, 664, 540), focused: true),
      ])
    let rendered = TreeFormatter.render(
      ElementTreeWalker.walk(root: window, windowFrame: windowFrame), coordinates: coordinates)

    let windowInfo = WindowInfo(
      ref: "window-1", id: 42, title: "Shopping list", focused: true, main: true, minimized: false,
      onScreen: true, modal: false, current: true, frame: Observation.Rect(windowFrame))
    let observation = Observation(
      snapshot: Self.observationId,
      app: notes,
      window: Observation.WindowSummary(
        ref: "window-1", id: 42,
        title: "Shopping list",
        frame: Observation.Rect(windowFrame),
        scale: Double(coordinates.scale)
      ),
      windows: [windowInfo],
      tree: rendered.text,
      elementCount: rendered.elementCount,
      truncated: rendered.truncated,
      geometry: coordinates.geometry,
      screenshot: Observation.Screenshot(
        mime: "image/jpeg",
        base64: try Self.tinyJPEGBase64(),
        width: size.width,
        height: size.height
      ),
      focusChanged: false,
      capturedAt: Observation.timestamp(Date(timeIntervalSince1970: 1_758_470_400))
    )

    var results: [String: any Encodable] = [
      "hello": Wire.HelloResult(
        ownerViewVersion: 3,
        helperVersion: "0.1.79",
        minProtocolVersion: HelperRuntime.minProtocolVersion,
        permissions: permissions,
        protocolVersion: HelperRuntime.protocolVersion,
        routes: Wire.HelloResult.Routes(windowLocation: true, windowGroups: true)
      ),
      "permissions.get": Wire.PermissionsResult(
        permissions: PermissionsState(accessibility: .granted, screenRecording: .denied)
      ),
      "permissions.request": Wire.PermissionsResult(permissions: permissions),
      "apps.installed": Wire.InstalledAppsResult(
        apps: [
          InstalledApp(
            identity: notes,
            running: true,
            iconPng: "iVBORw0KGgo="
          ),
          InstalledApp(
            identity: chrome,
            running: false,
            iconPng: nil
          ),
        ], total: 2),
      "app.resolve": Wire.ResolveAppResult(
        app: ResolvedApp(
          allowed: true,
          identity: chrome,
          path: "/Applications/Google Chrome.app",
          reason: AppPolicy.verdict(for: chrome.bundleId).reason,
          risk: AppPolicy.verdict(for: chrome.bundleId).risk,
          running: true
        )
      ),
      "session.windows": Wire.WindowsResult(windows: [windowInfo]),
      "session.bind": Wire.BindResult(window: windowInfo),
      "view.windows": Wire.OwnerWindowsResult(windows: [
        OwnerWindowInfo(
          id: 42, title: "Shopping list", focused: true, main: true, minimized: false,
          onScreen: true)
      ]),
      "session.open": Wire.SessionOpenResult(sessionId: Self.sessionId),
      "session.close": Wire.EmptyResult(),
      "session.observe": Wire.ObservationResult(observation: observation),
      "session.act": Wire.ActResult(
        performed: [
          ActionDescription.type(
            text: "Milk", field: ElementAttributes(role: "AXTextArea", help: "Note body")),
          ActionDescription.type(text: ", eggs", field: nil),
        ],
        error: nil
      ),
    ]

    let viewId = "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    for method in ["view.open", "view.renew", "view.activate", "view.close"] {
      results[method] = Wire.ViewStateResult(
        viewId: viewId, generation: 1, state: method == "view.close" ? "closed" : "ready",
        captureTargetId: method == "view.close" ? nil : "target-1",
        window: method == "view.open"
          ? Wire.ViewStateResult.OwnerWindowSummary(id: 42, title: "Shopping list") : nil)
    }
    results["display.control"] = MacOwnerInput.Control(state: "held", controlId: Self.controlId)
    results["display.input"] = MacOwnerInput.Result(sequence: 0, outcome: "dispatched")
    results["display.resolve"] = MacWindowVideoRegistry.ResolveResult(target: Self.videoTarget)
    results["display.start"] = MacWindowVideoRegistry.StartResult(attachmentToken: Self.bindingId)
    for method in ["display.demand", "display.refresh", "display.stop", "display.attach"] {
      results[method] = Wire.EmptyResult()
    }

    let dataResults: [String: any Encodable] = [
      "data.status": Wire.DataStatusResult(
        grants: DataGrants(
          automation: .unknown, calendars: .requestable, contacts: .granted,
          fullDiskAccess: .denied, reminders: .denied)),
      "data.request": Wire.DataStatusResult(
        grants: DataGrants(
          automation: .granted, calendars: .granted, contacts: .granted,
          fullDiskAccess: .granted, reminders: .denied)),
      // A real page, written by the search the helper runs, so the protocol
      // package can hold it to the catalog's output schema too.
      "data.invoke": Wire.DataInvokeResult(value: try JSONValue(encoding: try Self.contactsPage())),
    ]

    let imessageResults: [String: any Encodable] = [
      "imessage.account": IMessageAccountResult(
        account: IMessageAccount(
          handle: "bot@example.com", id: "A1B2C3D4-0000-4000-8000-000000000001"),
        end: IMessagePosition(guid: "8C5A1E2F-3B4D-4E6F-8A9B-0C1D2E3F4A5B", rowId: 4_182)),
      "imessage.poll": IMessagePoll(
        account: .current, claim: .held, cursor: .valid,
        rows: [
          IMessageRow(
            guid: "1F2E3D4C-5B6A-4798-8A7B-6C5D4E3F2A1B",
            message: IMessageInbound(
              handle: "+15551230000", sentAt: "2026-09-22T10:00:00Z", text: "What's on today?"),
            rowId: 4_183),
          IMessageRow(guid: "2A3B4C5D-6E7F-4801-9A2B-3C4D5E6F7A8B", message: nil, rowId: 4_184),
        ]),
      "imessage.send": IMessageReceipt(
        key: "cdl_01J9Z6Q0Y2E8C9T8Q5V6X7W8Z0", sentAt: "2026-09-22T10:00:05Z"),
    ]

    let events: [String: any Encodable] = [
      "display.owner-input": MacOwnerInput.Publication(streamId: Self.streamId, source: Self.ownerSource,
        controlId: Self.controlId, message: .init(type: "display.input.result", sequence: 0, outcome: "dispatched")),
      "session.stopped": SessionStoppedParams(reason: .user, sessionId: Self.sessionId),
      "display.state": MacVideoState(
        streamId: Self.streamId, state: "live", reason: nil,
        generation: 1, width: 1280, height: 720),
      "display.source-ended": MacWindowVideoRegistry.SourceEvent(
        streamId: Self.streamId,
        source: Self.videoSource, reason: "owner-ended"),
      "display.source-changed": MacWindowVideoRegistry.SourceEvent(
        streamId: Self.streamId,
        source: Self.videoSource, reason: "session-ended"),
    ]

    return Fixture(
      apps: try Self.apps(),
      error: AnyEncodable(
        ResponseEnvelope.failure(
          id: .number(7),
          error: HelperError(.busy, "This app is already being used by another task.")
        )
      ),
      events: events.mapValues { AnyEncodable($0) },
      requests: Self.requests(notes: notes).merging(Self.videoRequests()) { current, _ in current }
        .mapValues { AnyEncodable($0) },
      results: results.merging(dataResults) { current, _ in current }
        .merging(imessageResults) { current, _ in current }.mapValues {
          AnyEncodable($0)
        }
    )
  }

  /// The requests the helper reads, as it reads them: the Swift test below
  /// decodes each with the helper's own parameter types, and the protocol
  /// package parses each with its request schema.
  static func requests(notes: AppIdentity) -> [String: JSONValue] {
    let identity = JSONValue.object([
      "bundleId": .string(notes.bundleId),
      "displayName": .string(notes.displayName),
      "teamId": notes.teamId.map(JSONValue.string) ?? .null,
    ])
    return [
      "session.windows": .object([
        "id": .number(20), "method": .string("session.windows"), "timeoutMs": .number(30_000),
        "params": .object([
          "app": .object(["access": .string("read"), "identity": identity]),
          "sessionId": .string(sessionId),
        ]),
      ]),
      "session.bind": .object([
        "id": .number(21), "method": .string("session.bind"), "timeoutMs": .number(30_000),
        "params": .object([
          "app": .object(["access": .string("read"), "identity": identity]),
          "sessionId": .string(sessionId), "window": .number(42),
        ]),
      ]),
      "view.windows": .object([
        "id": .number(22), "method": .string("view.windows"), "timeoutMs": .number(30_000),
        "params": .object(["app": identity]),
      ]),
      "view.open": .object([
        "id": .number(23), "method": .string("view.open"), "timeoutMs": .number(30_000),
        "params": .object([
          "viewId": .string("cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "generation": .number(1),
          "leaseDurationMs": .number(30_000),
          "target": .object(["kind": .string("app"), "app": identity, "window": .number(42)]),
        ]),
      ]),
      "permissions.request": .object([
        "id": .number(5),
        "method": .string("permissions.request"),
        "params": .object(["pane": .string("screen-recording")]),
      ]),
      "session.open": .object([
        "id": .number(6),
        "method": .string("session.open"),
        "params": .object([
          "sessionId": .string(sessionId),
          "threadTitle": .string("Plan the week"),
        ]),
      ]),
      "session.observe": .object([
        "id": .number(7),
        "method": .string("session.observe"),
        "timeoutMs": .number(30_000),
        "params": .object([
          "app": .object(["access": .string("read"), "identity": identity]),
          "includeScreenshot": .bool(true),
          "window": .string("window-1"),
          "sessionId": .string(sessionId),
        ]),
      ]),
      "session.act": .object([
        "id": .number(8),
        "method": .string("session.act"),
        "timeoutMs": .number(45_000),
        "params": .object([
          "actions": .array([
            .object([
              "type": .string("type"), "text": .string("Milk"),
              "target": .object(["index": .number(4)]),
            ]),
            .object(["type": .string("type"), "text": .string(", eggs")]),
          ]),
          "app": .object(["access": .string("read-write"), "identity": identity]),
          "window": .string("window-1"),
          "snapshot": .string(observationId),
          "sessionId": .string(sessionId),
        ]),
      ]),
      "data.request": .object([
        "id": .number(9),
        "method": .string("data.request"),
        "params": .object(["grant": .string("contacts")]),
      ]),
      "data.invoke": .object([
        "id": .number(10),
        "method": .string("data.invoke"),
        "timeoutMs": .number(20_000),
        "params": .object([
          "access": .string("read"),
          "arguments": .object(["limit": .number(5), "query": .string("Ada")]),
          "contract": .string(
            DataContracts.operations["apple-contacts"]?["search_contacts"]?.contract ?? ""),
          "definitionId": .string("apple-contacts"),
          "effect": .string("read"),
          "operation": .string("search_contacts"),
        ]),
      ]),
      "imessage.poll": .object([
        "id": .number(11),
        "method": .string("imessage.poll"),
        "timeoutMs": .number(15_000),
        "params": .object([
          "accountId": .string("A1B2C3D4-0000-4000-8000-000000000001"),
          "after": .object([
            "guid": .string("8C5A1E2F-3B4D-4E6F-8A9B-0C1D2E3F4A5B"), "rowId": .number(4_182),
          ]),
          "limit": .number(100),
          "owner": .string("cha_01J9Z6Q0Y2E8C9T8Q5V6X7W8Y9"),
        ]),
      ]),
      "imessage.send": .object([
        "id": .number(12),
        "method": .string("imessage.send"),
        "timeoutMs": .number(30_000),
        "params": .object([
          "accountId": .string("A1B2C3D4-0000-4000-8000-000000000001"),
          "key": .string("cdl_01J9Z6Q0Y2E8C9T8Q5V6X7W8Z0"),
          "owner": .string("cha_01J9Z6Q0Y2E8C9T8Q5V6X7W8Y9"),
          "text": .string("On it."),
          "to": .string("+15551230000"),
        ]),
      ]),
    ]
  }

  private static let streamId = "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  private static let bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  private static let controlId = "dcl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  private static let ownerSource = MacVideoSource(kind: "owner-view", sessionId: nil, appKey: nil,
    viewId: "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1)
  private static let videoTarget = MacVideoTarget(kind: "mac-window", bindingId: bindingId)
  private static let videoSource = MacVideoSource(
    kind: "task-session", sessionId: sessionId,
    appKey: "com.apple.notes", viewId: nil, generation: nil)

  private static func videoRequests() -> [String: JSONValue] {
    let source = JSONValue.object([
      "kind": .string("task-session"), "sessionId": .string(sessionId),
      "appKey": .string("com.apple.notes"),
    ])
    let target = JSONValue.object(["kind": .string("mac-window"), "bindingId": .string(bindingId)])
    let owner = JSONValue.object(["kind": .string("owner-view"),
      "viewId": .string("cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "generation": .number(1)])
    let params: [String: JSONValue] = [
      "display.control": .object(["streamId": .string(streamId), "source": owner,
        "controlId": .string(controlId), "action": .string("acquire"), "access": .string("read-write")]),
      "display.input": .object(["streamId": .string(streamId), "source": owner,
        "controlId": .string(controlId), "geometry": .number(1), "sequence": .number(0),
        "events": .array([.object(["kind": .string("copy")])])]),
      "display.resolve": .object(["source": source]),
      "display.start": .object([
        "streamId": .string(streamId), "target": target, "sources": .array([source]),
        "maxLongSide": .number(1280), "maxFps": .number(30),
      ]),
      "display.demand": .object([
        "streamId": .string(streamId), "revision": .number(1), "sources": .array([source]),
      ]),
      "display.refresh": .object(["streamId": .string(streamId)]),
      "display.stop": .object(["streamId": .string(streamId)]),
      "display.attach": .object(["token": .string(bindingId)]),
    ]
    return params.reduce(into: [:]) { result, entry in
      result[entry.key] = .object([
        "id": .number(20), "method": .string(entry.key), "params": entry.value,
      ])
    }
  }

  /// Each fixture request is one the helper decodes, deadline included.
  func testTheHelperReadsEveryFixtureRequest() throws {
    let notes = AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil)
    for (method, request) in Self.requests(notes: notes).merging(Self.videoRequests(), uniquingKeysWith: { current, _ in current }) {
      let envelope = try request.decoded(as: RequestEnvelope.self)
      XCTAssertEqual(envelope.method, method)
      switch method {
      case "session.windows": _ = try envelope.decodeParams(Wire.WindowsParams.self, method: method)
      case "session.bind":
        XCTAssertEqual(try envelope.decodeParams(Wire.BindParams.self, method: method).window, 42)
      case "view.windows":
        _ = try envelope.decodeParams(Wire.OwnerWindowsParams.self, method: method)
      case "view.open":
        XCTAssertEqual(
          try envelope.decodeParams(Wire.ViewParams.self, method: method).target?.window, 42)
      case "permissions.request":
        XCTAssertEqual(
          try envelope.decodeParams(Wire.PermissionsRequestParams.self, method: method).pane,
          .screenRecording)
      case "session.open":
        XCTAssertEqual(
          try envelope.decodeParams(Wire.SessionOpenParams.self, method: method).threadTitle,
          "Plan the week")
        XCTAssertNil(try envelope.deadline(receivedAt: Date()))
      case "session.observe":
        let params = try envelope.decodeParams(Wire.ObserveParams.self, method: method)
        XCTAssertEqual(params.app, SessionApp(access: .read, identity: notes))
        XCTAssertNotNil(try envelope.deadline(receivedAt: Date()))
      case "display.control":
        _ = try envelope.decodeParams(MacOwnerInput.ControlParams.self, method: method)
      case "display.input":
        _ = try envelope.decodeParams(MacOwnerInput.InputParams.self, method: method)
      case "display.resolve":
        _ = try envelope.decodeParams(MacWindowVideoRegistry.ResolveParams.self, method: method)
      case "display.start":
        _ = try envelope.decodeParams(MacWindowVideoRegistry.StartParams.self, method: method)
      case "display.demand":
        _ = try envelope.decodeParams(MacWindowVideoRegistry.DemandParams.self, method: method)
      case "display.refresh", "display.stop":
        _ = try envelope.decodeParams(MacWindowVideoRegistry.StreamParams.self, method: method)
      case "display.attach":
        _ = try envelope.decodeParams(MacWindowVideoRegistry.AttachParams.self, method: method)
      case "session.act":
        let params = try envelope.decodeParams(Wire.ActParams.self, method: method)
        XCTAssertEqual(params.app.access, .readWrite)
        XCTAssertEqual(params.actions.count, 2)
        guard case .type("Milk", .index(4)?) = params.actions[0] else {
          return XCTFail("The first action types into element 4.")
        }
      case "data.request":
        XCTAssertEqual(
          try envelope.decodeParams(Wire.DataRequestParams.self, method: method).grant, .contacts)
      case "data.invoke":
        let params = try envelope.decodeParams(Wire.DataInvokeParams.self, method: method)
        XCTAssertEqual(params.definitionId, "apple-contacts")
        XCTAssertEqual(params.access, .read)
        XCTAssertEqual(params.effect, .read)
        XCTAssertEqual(
          try JSONValue.object(params.arguments).decoded(as: ContactsSearchArguments.self),
          ContactsSearchArguments(cursor: nil, limit: 5, query: "Ada"))
      case "imessage.poll":
        let params = try envelope.decodeParams(Wire.IMessagePollParams.self, method: method)
        XCTAssertEqual(
          params.after, IMessagePosition(guid: "8C5A1E2F-3B4D-4E6F-8A9B-0C1D2E3F4A5B", rowId: 4_182)
        )
        XCTAssertEqual(params.limit, 100)
      case "imessage.send":
        let params = try envelope.decodeParams(Wire.IMessageSendParams.self, method: method)
        XCTAssertEqual(params.key, "cdl_01J9Z6Q0Y2E8C9T8Q5V6X7W8Z0")
        XCTAssertEqual(params.to, "+15551230000")
      default:
        XCTFail("Unexpected request \(method).")
      }
    }
  }

  @MainActor
  private func text() throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let encoded = try encoder.encode(try fixture())
    return String(decoding: encoded, as: UTF8.self) + "\n"
  }

  /// The fixture, read back the way the protocol package will read it.
  @MainActor
  private func parsed() throws -> [String: Any] {
    let data = Data(try text().utf8)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @MainActor
  func testTheWireFixtureMatchesWhatTheHelperEncodes() throws {
    let text = try self.text()
    let url = Self.fixtureURL()

    if ProcessInfo.processInfo.environment["OPENSTEER_WRITE_WIRE_FIXTURE"] != nil
      || !FileManager.default.fileExists(atPath: url.path)
    {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try text.write(to: url, atomically: true, encoding: .utf8)
    }

    let onDisk = try String(contentsOf: url, encoding: .utf8)
    XCTAssertEqual(
      onDisk,
      text,
      "Tests/Fixtures/helper-wire.json is out of date. Regenerate it with "
        + "OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --filter HelperWireFixtureTests"
    )
  }

  /// Every method, every event and the error envelope are in the fixture, so a
  /// method added to the protocol cannot quietly go unpinned.
  @MainActor
  func testTheFixtureCoversEveryMethodAndEvent() throws {
    let fixture = try parsed()
    let results = try XCTUnwrap(fixture["results"] as? [String: Any])
    XCTAssertEqual(
      Set(results.keys),
      [
        "hello", "permissions.get", "permissions.request", "apps.installed", "app.resolve",
        "view.windows", "view.open", "view.renew", "view.close", "view.activate",
        "session.open", "session.close", "session.windows", "session.bind", "session.observe",
        "session.act",
        "display.resolve", "display.start", "display.demand", "display.refresh", "display.stop",
        "display.attach", "display.control", "display.input",
        "data.status",
        "data.request", "data.invoke", "imessage.account", "imessage.poll", "imessage.send",
      ]
    )
    let events = try XCTUnwrap(fixture["events"] as? [String: Any])
    XCTAssertEqual(
      Set(events.keys),
      ["session.stopped", "display.state", "display.source-ended", "display.source-changed", "display.owner-input"])
    let requests = try XCTUnwrap(fixture["requests"] as? [String: Any])
    XCTAssertEqual(
      Set(requests.keys),
      [
        "permissions.request", "view.windows", "view.open", "session.windows", "session.bind",
        "session.open", "session.observe", "session.act",
        "display.resolve", "display.start", "display.demand", "display.refresh", "display.stop",
        "display.attach", "display.control", "display.input",
        "data.request",
        "data.invoke", "imessage.poll", "imessage.send",
      ])
    let act = try XCTUnwrap(requests["session.act"] as? [String: Any])
    let params = try XCTUnwrap(act["params"] as? [String: Any])
    XCTAssertEqual(params["snapshot"] as? String, Self.observationId)
    let close = try XCTUnwrap(results["session.close"] as? [String: Any])
    XCTAssertTrue(close.isEmpty, "session.close answers with an empty object.")
    let hello = try XCTUnwrap(results["hello"] as? [String: Any])
    XCTAssertEqual(hello["protocolVersion"] as? Int, 10)
    XCTAssertEqual(hello["minProtocolVersion"] as? Int, 10)
  }

  @MainActor
  func testTheFixtureObservationStaysInsideItsBudgets() throws {
    let fixture = try parsed()
    let results = try XCTUnwrap(fixture["results"] as? [String: Any])
    let observe = try XCTUnwrap(results["session.observe"] as? [String: Any])
    let observation = try XCTUnwrap(observe["observation"] as? [String: Any])
    let tree = try XCTUnwrap(observation["tree"] as? String)
    XCTAssertLessThanOrEqual(tree.utf8.count, TreeFormatter.maxBytes)
    let screenshot = try XCTUnwrap(observation["screenshot"] as? [String: Any])
    let base64 = try XCTUnwrap(screenshot["base64"] as? String)
    XCTAssertLessThanOrEqual(base64.utf8.count, WindowCapture.maxBase64Bytes)
    XCTAssertNotNil(Data(base64Encoded: base64), "The fixture picture must decode.")
    XCTAssertEqual(screenshot["mime"] as? String, "image/jpeg")
    let width = try XCTUnwrap(screenshot["width"] as? Int)
    let height = try XCTUnwrap(screenshot["height"] as? Int)
    XCTAssertLessThanOrEqual(max(width, height), WindowCapture.maxLongSide)
    XCTAssertLessThanOrEqual(width * height, WindowCapture.maxPixelCount)
    XCTAssertEqual(observation["elementCount"] as? Int, 5)
  }

  /// `#filePath` is this file, so the fixture lands beside the tests whether
  /// they run from SwiftPM or from Xcode.
  private static func fixtureURL() -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Fixtures/helper-wire.json")
  }
}
