import AppKit
import Carbon.HIToolbox
import ApplicationServices
import CoreGraphics
import Foundation

@globalActor
actor PersonInputActor {
  static let shared = PersonInputActor()
  private let queue = DispatchSerialQueue(label: "com.opensteer.person-input", qos: .userInteractive)
  nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }
}

struct MacOwnerInputMap: Sendable {
  let generation: Int
  let crop: CGRect
  let windows: [ObservedWindow]
  let revision: Int

  func target(x: Double, y: Double, process: pid_t, pinned: EventTarget? = nil) throws -> EventTarget {
    let point = CGPoint(x: crop.minX + x * crop.width, y: crop.minY + y * crop.height)
    if let pinned, pinned.processIdentifier != process { throw MacOwnerInput.Refusal("stale") }
    let window = pinned.flatMap { held in windows.first { $0.windowID == held.windowID } }
      ?? (pinned == nil ? windows.first { $0.frame.contains(point) } : nil)
    guard let window else { throw MacOwnerInput.Refusal("stale") }
    return EventTarget(processIdentifier: process, windowID: window.windowID,
      screenPoint: point, windowPoint: CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY))
  }
}

struct OwnerInputAXBudget: Sendable {
  @TaskLocal static var current: OwnerInputAXBudget?

  let deadline: TimeInterval
  var limit: Float = axMessagingTimeout
  var effects: Locked<Bool>? = nil
  var timedOut = Locked(false)
  var now: @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  var check: @Sendable () throws -> Void

  func timeout(maximum: Float? = nil) -> Float? {
    guard !timedOut.current, (try? check()) != nil else { return nil }
    let remaining = deadline - now()
    guard remaining > 0 else { return nil }
    return Float(min(Double(min(limit, maximum ?? limit)), remaining))
  }

  static func prepare(_ element: AXUIElement, maximum: Float? = nil) -> Bool {
    guard let current else { return true }
    guard let timeout = current.timeout(maximum: maximum) else { return false }
    return AXUIElementSetMessagingTimeout(element, timeout) == .success
  }

  static func received(_ status: AXError) -> AXError {
    if status == .cannotComplete { current?.timedOut.withLock { $0 = true } }
    return status
  }
}

/// Person input contains no observation, action descriptions or task receipts.
/// Only explicitly requested, nonsecure copy can carry text back to its source.
enum MacOwnerInput {
  struct Refusal: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
  struct Edit: Decodable, Sendable {
    let contextId: String; let text: String; let before: String; let after: String
  }
  struct ClipboardItem: Decodable, Sendable { let type: String; let name: String?; let size: Int }
  struct Event: Decodable, Sendable {
    let kind: String
    let action: String?
    let code: String?
    let key: String?
    let modifiers: [String]?
    let text: String?
    let items: [ClipboardItem]?
    let `repeat`: Bool?
    let location: Int?
    let phase: String?
    let button: String?
    let clickCount: Int?
    let x: Double?
    let y: Double?
    let dx: Double?
    let dy: Double?
    let command: String?
    let contextId: String?
    let edit: Edit?

    func validate() throws {
      guard ["mouse", "scroll", "key", "command", "edit", "copy", "paste"].contains(kind),
        (modifiers ?? []).count <= 5,
        (modifiers ?? []).allSatisfy({ ["alt", "control", "meta", "shift", "primary"].contains($0) })
      else { throw Refusal("unsupported") }
      switch kind {
      case "mouse", "scroll":
        guard let x, let y, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y)
        else { throw Refusal("unsupported") }
        if kind == "mouse" {
          guard ["down", "move", "up", "cancel"].contains(phase ?? ""),
            ["none", "left", "middle", "right"].contains(button ?? ""),
            !["down", "up"].contains(phase ?? "") || button != "none",
            (1...3).contains(clickCount ?? 1) else { throw Refusal("unsupported") }
        } else {
          guard let dx, let dy, dx.isFinite, dy.isFinite, (-1...1).contains(dx), (-1...1).contains(dy)
          else { throw Refusal("unsupported") }
        }
      case "key":
        guard ["down", "up"].contains(action ?? ""), let key, key.utf16.count <= 100,
          let code, code.utf16.count <= 100, (0...3).contains(location ?? 0), text == nil || (1...64).contains(text!.utf16.count)
        else { throw Refusal("unsupported") }
      case "edit":
        guard let edit, UUID(uuidString: edit.contextId) != nil,
          [edit.text, edit.before, edit.after].allSatisfy({ $0.utf16.count <= 10_000 }),
          !edit.text.isEmpty || !edit.before.isEmpty || !edit.after.isEmpty
        else { throw Refusal("unsupported") }
      case "paste":
        if items != nil { throw Refusal("unsupported") }
        guard let text, (1...30_000).contains(text.utf16.count) else { throw Refusal("too-large") }
        guard let contextId, UUID(uuidString: contextId) != nil else { throw Refusal("unsupported") }
      case "command":
        guard MacOwnerInput.commands[command ?? ""] != nil,
          let contextId, UUID(uuidString: contextId) != nil else { throw Refusal("unsupported") }
      case "copy":
        guard let contextId, UUID(uuidString: contextId) != nil else { throw Refusal("unsupported") }
      default: break
      }
    }
    var flags: CGEventFlags {
      (modifiers ?? []).reduce(into: CGEventFlags()) { result, modifier in
        switch modifier {
        case "primary", "meta": result.insert(.maskCommand)
        case "alt": result.insert(.maskAlternate)
        case "control": result.insert(.maskControl)
        case "shift": result.insert(.maskShift)
        default: break
        }
      }
    }
  }
  static func releasesOnly(_ events: [Event]) -> Bool {
    !events.isEmpty && events.allSatisfy {
      ($0.kind == "key" && $0.action == "up")
        || ($0.kind == "mouse" && ($0.phase == "up" || $0.phase == "cancel"))
    }
  }

  static func changesEditing(_ events: [Event], buttonsHeld: Bool) -> Bool {
    // tickOwnerInput's idle publication still observes hover-driven focus/caret changes.
    buttonsHeld || !events.allSatisfy { $0.kind == "mouse" && $0.phase == "move" }
  }
  struct ResetParams: Decodable { let streamId: String; let source: MacVideoSource }
  struct InputParams: Decodable, Sendable { let streamId: String; let source: MacVideoSource; let geometry: Int; let sequence: Int; let events: [Event] }
  struct Batch: Sendable {
    let params: InputParams
    let reservation: OwnerInputAdmission.Reservation
    let deadline: TimeInterval
    let reply: CheckedContinuation<Result, Never>
  }
  struct Result: Encodable, Sendable { let sequence: Int; let outcome: String; var reason: String? = nil }
  struct Field: Encodable, Sendable { let kind: String; let multiline: Bool; let sensitive: Bool }
  struct Caret: Encodable, Sendable { let x: Double; let y: Double; let height: Double }
  struct Context: Encodable, Sendable {
    let contextId: String; let field: Field?; let caret: Caret?
    // Null is meaningful on the shared editing wire.
    func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(contextId, forKey: .contextId)
      try c.encode(field, forKey: .field); try c.encode(caret, forKey: .caret)
    }
    enum CodingKeys: String, CodingKey { case contextId, field, caret }
  }
  struct Message: Encodable, Sendable {
    let type: String
    var state: String? = nil
    var reason: String? = nil
    var sequence: Int? = nil
    var outcome: String? = nil
    var generation: Int? = nil
    var context: Context? = nil
    var text: String? = nil
  }
  struct Publication: Encodable, Sendable {
    let streamId: String; let source: MacVideoSource; let message: Message
  }
  static let commands: [String: String] = [
    "selectAll": "cmd+a", "undo": "cmd+z", "redo": "cmd+shift+z",
    "moveBackward": "left", "moveForward": "right", "moveUp": "up", "moveDown": "down",
    "moveWordLeft": "alt+left", "moveWordRight": "alt+right",
    "moveWordLeftAndModifySelection": "alt+shift+left", "moveWordRightAndModifySelection": "alt+shift+right",
    "moveToLeftEndOfLine": "cmd+left", "moveToRightEndOfLine": "cmd+right",
    "moveToLeftEndOfLineAndModifySelection": "cmd+shift+left", "moveToRightEndOfLineAndModifySelection": "cmd+shift+right",
    "moveToBeginningOfLine": "cmd+left", "moveToEndOfLine": "cmd+right",
    "moveToBeginningOfLineAndModifySelection": "cmd+shift+left", "moveToEndOfLineAndModifySelection": "cmd+shift+right",
    "moveToBeginningOfParagraph": "alt+up", "moveToEndOfParagraph": "alt+down",
    "moveToBeginningOfParagraphAndModifySelection": "alt+shift+up", "moveToEndOfParagraphAndModifySelection": "alt+shift+down",
    "moveToBeginningOfDocument": "cmd+up", "moveToEndOfDocument": "cmd+down",
    "moveToBeginningOfDocumentAndModifySelection": "cmd+shift+up", "moveToEndOfDocumentAndModifySelection": "cmd+shift+down",
    "deleteBackward": "delete", "deleteForward": "forwarddelete", "deleteWordBackward": "alt+delete",
    "deleteWordForward": "alt+forwarddelete", "deleteToBeginningOfLine": "cmd+delete",
    "deleteToEndOfLine": "ctrl+k", "deleteToEndOfParagraph": "ctrl+k", "transpose": "ctrl+t", "yank": "ctrl+y",
  ]
}

final class MacOwnerAttachment: @unchecked Sendable {
  let id: String
  let streamID: String
  let source: MacVideoSource
  let connection: IPCConnection
  let binding: MacVideoBinding
  let producer: any MacVideoProducing
  let mutations: AppMutationCoordinator
  let generation: Int?
  private let pathValue: Locked<String>
  private let verification: (@Sendable () async throws -> String)?
  private let verified = Locked(false)
  var path: String { pathValue.current }
  func verifyPath() async throws {
    if verified.current { return }
    if let verification { let path = try await verification(); pathValue.withLock { $0 = path } }
    verified.withLock { $0 = true }
  }
  let focus = FocusSlot()
  let admission = OwnerInputAdmission()
  let queue = SerialTaskChain()
  let mailbox = OwnerInputMailbox<MacOwnerInput.Batch>()
  let guardFailed = Locked(false)
  let burstActive = Locked(false)
  let active = Locked(true)
  let heldDeadline = Locked<TimeInterval?>(nil)
  let contextPending = Locked(false)
  let worker = MacOwnerInputWorker()
  let counters = Locked<[String: Int]>([:])
  func count(_ kind: String) { counters.withLock { $0[kind, default: 0] += 1 } }

  init(id: String, streamID: String, source: MacVideoSource, connection: IPCConnection,
       binding: MacVideoBinding, producer: any MacVideoProducing, mutations: AppMutationCoordinator,
       path: String, verification: (@Sendable () async throws -> String)? = nil) {
    self.id = id; self.streamID = streamID; self.source = source; self.connection = connection
    self.binding = binding; self.producer = producer; self.mutations = mutations; self.generation = producer.inputMap?.generation; self.pathValue = Locked(path); self.verification = verification
  }
  func emit(_ message: MacOwnerInput.Message) {
    guard !connection.closedFlag else { return }
    connection.send(event: EventEnvelope(event: "display.owner-input", params: MacOwnerInput.Publication(
      streamId: streamID, source: source, message: message)))
  }
  func check(_ map: MacOwnerInputMap, secureMetadata: Bool = false) throws {
    if !secureMetadata, IsSecureEventInputEnabled() { throw MacOwnerInput.Refusal("sensitive") }
    guard active.current, !guardFailed.current, !connection.closedFlag,
      binding.target.process.isCurrent, binding.unavailable == nil, AXIsProcessTrusted(), producer.inputVisible,
      producer.inputMap?.generation == generation,
      producer.inputMap?.generation == map.generation,
      binding.window.lifecycleRevision == map.revision,
      (try? HelperRuntime.requireUnlocked()) != nil,
      NSRunningApplication(processIdentifier: binding.target.process.processIdentifier)?.isHidden == false
    else { throw MacOwnerInput.Refusal("stale") }
    // WindowServer geometry is independent of delayed AX notifications.
    for window in map.windows {
      guard KeyWindow.captureState(window.windowID, processIdentifier: binding.target.process.processIdentifier)?.frame == window.frame
      else { throw MacOwnerInput.Refusal("stale") }
    }
  }
}

@PersonInputActor
final class OwnerShortcutPolicy {
  enum Resolution {
    case menuItem(AXUIElement)
    case disabled
    case keystroke
  }

  /// AppKit's `NSMenu` AX validation (`accessibilityChildren` / `AXEnabled`) throttles
  /// `-[NSMenu update]` to once per 1.0 s, so a menu item just enabled by a prior `AXPress`
  /// (such as Edit › Redo after Undo) can read disabled until that 1.0 s window clears.
  /// Bound: 1150 ms (1.0 s AppKit throttle + 150 ms scheduling margin under load).
  nonisolated static let disabledShortcutWait: TimeInterval = 1.15

  private var index: MenuShortcutIndex?
  private var pid: pid_t?
  private let makeIndex: @Sendable () -> MenuShortcutIndex
  private let isEnabled: @Sendable (AXUIElement) -> Bool?
  nonisolated init(
    makeIndex: @escaping @Sendable () -> MenuShortcutIndex = { MenuShortcutIndex() },
    isEnabled: @escaping @Sendable (AXUIElement) -> Bool? = { MenuShortcutIndex.isEnabled($0) }
  ) {
    self.makeIndex = makeIndex
    self.isEnabled = isEnabled
  }
  func invalidate() {
    index?.invalidate()
  }
  var diagnosticSnapshot: (shortcuts: [String], disabled: [String], complete: Bool)? {
    index?.diagnosticSnapshot
  }
  func route(
    _ combo: KeyCombo,
    pid: pid_t,
    wait: TimeInterval = disabledShortcutWait,
    pollIntervalNanoseconds: UInt64 = 25_000_000,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    checkGate: @escaping @Sendable () throws -> Void = {}
  ) async throws -> Resolution {
    guard !combo.modifiers.isEmpty else { return .keystroke }
    if self.pid != pid {
      index?.invalidate()
      self.pid = pid
    }
    let index = self.index ?? makeIndex()
    self.index = index
    // Every real menu chord (cmd/ctrl/alt) reads the live menu bar so added, removed,
    // rebound, or newly disabled items never go stale; plain/shifted typing keeps the cache.
    if !combo.modifiers.isDisjoint(with: [.cmd, .ctrl, .alt]) {
      index.invalidate()
    }
    let app = AXUIElementCreateApplication(pid)

    func resolve(_ lookup: MenuShortcutIndex.Lookup) throws -> Resolution? {
      switch lookup {
      case .reserved:
        throw ActionRunner.reservedShortcut
      case .item(let item):
        return .menuItem(item)
      case .none:
        return .keystroke
      case .unverified:
        guard combo.modifiers.isDisjoint(with: [.cmd, .ctrl, .alt]) else {
          throw ActionRunner.unverifiedShortcut
        }
        return .keystroke
      case .disabled:
        return nil
      }
    }

    let initial = index.lookup(combo, applicationElement: app)
    if let resolved = try resolve(initial) { return resolved }
    guard case .disabled(var current) = initial else { return .keystroke }

    let deadline = now() + wait
    while true {
      try checkGate()
      let remaining = deadline - now()
      if remaining <= 0 { break }
      let sleepNs = min(pollIntervalNanoseconds, UInt64(max(1, remaining * 1_000_000_000)))
      try await Task.sleep(nanoseconds: sleepNs)
      try checkGate()
      if let enabled = isEnabled(current) {
        if enabled { return .menuItem(current) }
      } else {
        index.invalidate()
        let refreshed = index.lookup(combo, applicationElement: app)
        if let resolved = try resolve(refreshed) { return resolved }
        if case .disabled(let replacement) = refreshed { current = replacement }
      }
    }
    return .disabled
  }
}

@PersonInputActor
final class MacOwnerInputWorker {
  private struct HeldKey {
    let code: CGKeyCode; let target: EventTarget; let token: AXWindowToken
    var modifier = false
    var characters: String? = nil
    var menuHandled = false
  }
  private struct HeldButton { let target: EventTarget; let token: AXWindowToken }
  private var keys: [String: HeldKey] = [:]
  private var buttons: [String: HeldButton] = [:]
  private var generation: Int?
  private var focusAfterClickUntil: TimeInterval = 0
  private var contextRevision = -1
  /// The field's editing contexts, governed by the shared editing-admission rule
  /// (`docs/editing-admission.md`, `OwnerEditingContexts`).
  private var contexts = OwnerEditingContexts()
  private var contextID: String { contexts.current }
  private var focusedField: (element: AXUIElement, role: String, secure: Bool, id: String)?
  private var nextFieldID = 0
  private var selection: CFRange?
  /// True while an unconfirmed text-mutating edit is in flight, so AX offsets at `predictedState`
  /// may not match live document offsets yet (A1).
  private var pendingTextMutation = false
  private let shortcutPolicy = OwnerShortcutPolicy()

  nonisolated init() {}

  func cleanup(_ lease: MacOwnerAttachment, forgetField: Bool = true) async {
    let keys = keys, buttons = buttons
    self.keys.removeAll(); self.buttons.removeAll()
    if forgetField {
      focusAfterClickUntil = 0
      focusedField = nil; selection = nil
      pendingTextMutation = false
      shortcutPolicy.invalidate()
      contexts.reset()
    }
    lease.heldDeadline.withLock { $0 = nil }
    defer { lease.mutations.setHeld(false, attachment: lease.id) }
    guard lease.binding.target.process.isCurrent else { return }
    // The retained AX token prevents reuse of the window number. Cleanup only asks WindowServer.
    for key in keys.values where !key.menuHandled {
      guard KeyWindow.captureState(key.target.windowID, processIdentifier: key.target.processIdentifier) != nil
      else { continue }
      try? await SyntheticEvents.ownerKey(down: false, virtualKey: key.code, flags: [], text: nil, repeatKey: false, target: key.target, modifier: key.modifier)
    }
    for (name, held) in buttons {
      let target = held.target
      guard let button = MouseButton(rawValue: name), KeyWindow.captureState(target.windowID, processIdentifier: target.processIdentifier) != nil else { continue }
      let types = await SyntheticEvents.mouseTypes(button)
      try? await SyntheticEvents.postMouse(type: types.up, target: target, button: button, clickCount: 1, pressure: 0)
    }
  }

  func drain(_ lease: MacOwnerAttachment) async {
    repeat {
      guard let batch = lease.mailbox.pop() else {
        if lease.mailbox.finishIfEmpty() { return }
        continue
      }
      let current = Locked<MacOwnerInput.Batch?>(batch)
      await lease.mutations.beginPerson()
      let burst = Locked(OwnerInputBurst(started: ProcessInfo.processInfo.systemUptime))
      lease.burstActive.withLock { $0 = true }
      var enteredFocus = false
      do {
        guard lease.active.current, lease.admission.isCurrent(batch.reservation) else { throw MacOwnerInput.Refusal("unavailable") }
        guard !lease.mutations.heldByOther(lease.id) else { throw MacOwnerInput.Refusal("contended") }
        guard ProcessInfo.processInfo.systemUptime < batch.deadline
        else { throw MacOwnerInput.Refusal("unavailable") }
        try await lease.verifyPath()
        guard lease.active.current, lease.admission.isCurrent(batch.reservation) else { throw MacOwnerInput.Refusal("unavailable") }
        if MacOwnerInput.releasesOnly(batch.params.events) {
          let result = await run(batch, lease: lease, proceed: {})
          batch.reply.resume(returning: result)
          lease.burstActive.withLock { $0 = false }
          lease.mutations.endPerson()
          await publishUnlessPending(lease)
          continue
        }
        guard let map = lease.producer.inputMap,
          let enforcer = lease.focus.personEnforcer(for: lease.binding.target.process.processIdentifier)
        else { throw MacOwnerInput.Refusal("stale") }
        guard lease.active.current, lease.admission.isCurrent(batch.reservation) else { throw MacOwnerInput.Refusal("unavailable") }
        try lease.check(map)
        enteredFocus = true
        let preparation = OwnerInputAXBudget(deadline: batch.deadline, check: {
          guard lease.active.current else { throw MacOwnerInput.Refusal("unavailable") }
        })
        _ = try await enforcer.guardedPerson(window: lease.binding.window.element, prepare: true, keys: true,
          axBudget: preparation, finalCheck: { try lease.check(map) }, check: {
            try lease.check(map)
            guard preparation.timeout() != nil else { throw MacOwnerInput.Refusal("unavailable") }
          },
          hasPendingInput: {
            lease.active.current && !lease.guardFailed.current
              && !lease.mutations.hasWaitingInput
              && burst.current.acceptsInput(at: ProcessInfo.processInfo.systemUptime)
              && lease.mailbox.hasPending
          },
          releaseIfStopped: {
            if !lease.active.current, !self.keys.isEmpty || !self.buttons.isEmpty {
              await self.cleanup(lease)
            }
          }
        ) { proceed in
          if current.current == nil { current.withLock { $0 = lease.mailbox.pop() } }
          await self.consumeBurst(lease, current: current, burst: burst, proceed: proceed)
        }
      } catch {
        let refusal = error as? MacOwnerInput.Refusal
        MacVideoDiagnostic.write(["event": "owner-input-preparation-refused", "streamId": lease.streamID,
          "reason": refusal?.reason ?? "focus-guard", "focusEntered": enteredFocus])
        // Map/security refusals are safe after restoration; focus errors are fatal.
        if refusal == nil { lease.guardFailed.withLock { $0 = true } }
        await cleanup(lease, forgetField: refusal == nil)
        if let pending = current.withLock({ value in defer { value = nil }; return value }) {
          let reason = !lease.active.current || !lease.admission.isCurrent(pending.reservation)
            ? "unavailable" : (error as? MacOwnerInput.Refusal)?.reason ?? "unsupported"
          lease.admission.complete(pending.reservation)
          pending.reply.resume(returning: .init(sequence: pending.params.sequence,
            outcome: reason == "stale" ? "stale" : "refused", reason: reason))
        }
      }
      lease.burstActive.withLock { $0 = false }
      lease.mutations.endPerson()
      await publishUnlessPending(lease)
    } while !lease.mailbox.finishIfEmpty()
  }

  private func consumeBurst(_ lease: MacOwnerAttachment, current: Locked<MacOwnerInput.Batch?>,
                            burst: Locked<OwnerInputBurst>,
                            proceed: @escaping @Sendable () throws -> Void) async {
    while let batch = current.withLock({ value in defer { value = nil }; return value }) {
      let result = await run(batch, lease: lease, proceed: proceed)
      batch.reply.resume(returning: result)
      if result.outcome != "dispatched" { burst.withLock { $0.end() }; return }
      guard lease.active.current, !lease.guardFailed.current,
        burst.current.acceptsInput(at: ProcessInfo.processInfo.systemUptime) else {
        burst.withLock { $0.end() }
        if !lease.active.current { await cleanup(lease) }
        return
      }
      let next = lease.mailbox.pop()
      guard let next else {
        if !lease.active.current { await cleanup(lease) }
        return
      }
      current.withLock { $0 = next }
    }
  }

  func run(_ batch: MacOwnerInput.Batch, lease: MacOwnerAttachment,
           proceed: @escaping @Sendable () throws -> Void) async -> MacOwnerInput.Result {
    let params = batch.params, reservation = batch.reservation
    defer { lease.admission.complete(reservation) }
    let effects = Locked(false)
    let timedOut = Locked(false)
    let check: @Sendable () throws -> Void = {
      guard !timedOut.current, lease.active.current, lease.admission.isCurrent(reservation),
        ProcessInfo.processInfo.systemUptime < batch.deadline
      else { throw MacOwnerInput.Refusal("unavailable") }
    }
    let gate: @Sendable () throws -> Void = { try check(); try proceed() }
    let budget = OwnerInputAXBudget(deadline: batch.deadline, effects: effects, timedOut: timedOut, check: check)
    do {
      guard lease.active.current, lease.admission.isCurrent(reservation) else { throw MacOwnerInput.Refusal("unavailable") }
      guard lease.admission.isCurrent(reservation), let map = lease.producer.inputMap,
        params.geometry == map.generation else { throw MacOwnerInput.Refusal("stale") }
      if let prev = generation, prev != map.generation { await cleanup(lease, forgetField: true) }
      generation = map.generation
      try lease.check(map)
      MacVideoDiagnostic.write(["event": "owner-input-admitted", "streamId": lease.streamID,
        "inputSequence": params.sequence, "generation": map.generation,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      try gate()
      let changesEditing = MacOwnerInput.changesEditing(params.events, buttonsHeld: !buttons.isEmpty)
      defer {
        if changesEditing && effects.current { lease.mutations.notePersonEdit() }
      }
      try await OwnerInputAXBudget.$current.withValue(budget) {
        try await dispatch(params, lease: lease, map: map, proceed: gate)
      }
      try gate()
      lease.count("outcome.dispatched")
      return MacOwnerInput.Result(sequence: params.sequence, outcome: "dispatched")
    } catch let refusal as MacOwnerInput.Refusal {
      let reason = timedOut.current ? "unavailable" : refusal.reason
      lease.count("refused." + reason)
      // Release held contacts without forgetting earlier contexts or rotating on refusal.
      await cleanup(lease, forgetField: false)
      return MacOwnerInput.Result(sequence: params.sequence,
        outcome: effects.current ? "unknown" : reason == "stale" ? "stale" : "refused", reason: reason)
    } catch {
      await cleanup(lease, forgetField: false)
      return MacOwnerInput.Result(sequence: params.sequence, outcome: effects.current ? "unknown" : "refused",
        reason: timedOut.current ? "unavailable" : "unsupported")
    }
  }

  /// P2 (Rule 2 dependency): events in one `display.input` batch run strictly in order and the
  /// batch stops at its first refusal. Anything that may already have taken effect is unknown.
  private func dispatch(_ params: MacOwnerInput.InputParams, lease: MacOwnerAttachment,
                        map: MacOwnerInputMap, proceed: @escaping @Sendable () throws -> Void) async throws {
    for event in params.events {
      try proceed(); try lease.check(map)
      lease.count("kind." + event.kind)
      MacVideoDiagnostic.write(["event": "owner-input-dispatch", "streamId": lease.streamID,
        "inputSequence": params.sequence, "generation": map.generation,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      switch event.kind {
      case "mouse": try await mouse(event, lease: lease, map: map, proceed: proceed)
      case "scroll":
        let target = try map.target(x: event.x!, y: event.y!, process: lease.binding.target.process.processIdentifier)
        try await SyntheticEvents.ownerScroll(dx: event.dx! * map.crop.width, dy: event.dy! * map.crop.height,
          target: target, gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
      case "key": try await key(event, lease: lease, map: map, proceed: proceed)
      case "command":
        let focused = try await keyboardAfterClick(lease, map: map, proceed: proceed)
        guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
        refresh(focused, agentRevision: lease.mutations.agentRevision)
        let kind: OwnerEditingContexts.AdmissionKind =
          OwnerEditingContexts.caretRelativeCommands.contains(event.command!) ? .relative : .exact
        guard contexts.admits(event.contextId!, kind: kind, collapsed: selection?.length == 0) else {
          throw MacOwnerInput.Refusal("stale")
        }
        let prepared = prepareCommandPrediction(event.command!, focused: focused)
        let combo = try KeyComboParser.parse(MacOwnerInput.commands[event.command!]!)
        try await chord(combo, target: focused.target, lease: lease, map: map, proceed: proceed)
        predictCommand(event.command!, prepared: prepared)
      case "edit": try await edit(event.edit!, lease: lease, map: map, proceed: proceed)
      case "paste":
        let focused = try await keyboardAfterClick(lease, map: map, proceed: proceed)
        guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
        refresh(focused, agentRevision: lease.mutations.agentRevision)
        guard contexts.admits(event.contextId!, kind: .relative, collapsed: selection?.length == 0) else {
          throw MacOwnerInput.Refusal("stale")
        }
        try await insert(event.text!, focused: focused, lease: lease, map: map, proceed: proceed)
        predictInsertion(event.text!)
      case "copy":
        do { try await copy(contextId: event.contextId!, sequence: params.sequence, lease: lease, map: map, proceed: proceed) }
        catch {
          lease.count("clipboard.refused")
          lease.emit(.init(type: "display.clipboard", sequence: params.sequence,
            outcome: (error as? MacOwnerInput.Refusal)?.reason == "too-large" ? "too-large" : "refused"))
          throw error
        }
      default: throw MacOwnerInput.Refusal("unsupported")
      }
    }
    lease.mutations.setHeld(!keys.isEmpty || !buttons.isEmpty, attachment: lease.id)
    if !keys.isEmpty || !buttons.isEmpty {
      lease.heldDeadline.withLock { $0 = ProcessInfo.processInfo.systemUptime + 5 }
    } else { lease.heldDeadline.withLock { $0 = nil } }
  }

  private func mouse(_ event: MacOwnerInput.Event, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                     proceed: @escaping @Sendable () throws -> Void) async throws {
    let phase = event.phase!
    let name = phase == "move" && event.button == "none"
      ? (["left", "right", "middle"].first { buttons[$0] != nil } ?? "none") : event.button!
    if phase == "cancel" { try Self.beginEffect(proceed); await cleanup(lease, forgetField: false); return }
    let held = buttons[name]
    if phase == "up", held == nil { throw MacOwnerInput.Refusal("stale") }
    if phase == "down", held != nil { throw MacOwnerInput.Refusal("stale") }
    let button = MouseButton(rawValue: name) ?? .left
    let target = try map.target(x: event.x!, y: event.y!,
      process: lease.binding.target.process.processIdentifier, pinned: held?.target)
    let retained = phase == "down" ? try token(for: target, lease: lease) : held?.token
    let types = await SyntheticEvents.mouseTypes(button)
    let type: NSEvent.EventType
    switch phase {
    case "down": type = types.down
    case "up": type = types.up
    default:
      type = held == nil ? .mouseMoved : button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
    }
    try await SyntheticEvents.postMouse(type: type, target: target, button: button,
      clickCount: event.clickCount ?? 1, pressure: phase == "up" || name == "none" ? 0 : 1,
      flags: event.flags, gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
    if phase == "down", let retained { buttons[name] = HeldButton(target: target, token: retained) }
    if phase == "up" {
      buttons[name] = nil
      if button == .left { focusAfterClickUntil = ProcessInfo.processInfo.systemUptime + 0.5 }
    }
    if phase == "move", let held { buttons[name] = HeldButton(target: target, token: held.token) }
  }

  private func key(_ event: MacOwnerInput.Event, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                   proceed: @escaping @Sendable () throws -> Void) async throws {
    let identity = event.code!, down = event.action == "down"
    if !down {
      guard let held = keys[identity] else { return }
      if held.menuHandled { keys[identity] = nil; return }
      guard KeyWindow.captureState(held.target.windowID, processIdentifier: held.target.processIdentifier) != nil else { throw MacOwnerInput.Refusal("stale") }
      try await SyntheticEvents.ownerKey(down: false, virtualKey: held.code, flags: event.flags, text: held.characters,
        repeatKey: false, target: held.target, modifier: held.modifier, gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
      keys[identity] = nil
      return
    }
    let focused = try await keyboardAfterClick(lease, map: map, proceed: proceed)
    guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
    let right = event.location == 2 || event.code?.hasSuffix("Right") == true
    let modifierCode: CGKeyCode?
    switch event.key {
    case "Shift": modifierCode = right ? 60 : 56
    case "Control": modifierCode = right ? 62 : 59
    case "Alt": modifierCode = right ? 61 : 58
    case "Meta": modifierCode = right ? 54 : 55
    default: modifierCode = nil
    }
    if let code = modifierCode {
      if keys[identity] != nil, event.repeat != true { throw MacOwnerInput.Refusal("stale") }
      try await SyntheticEvents.ownerKey(down: true, virtualKey: code, flags: event.flags, text: nil,
        repeatKey: false, target: focused.target, modifier: true,
        gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
      keys[identity] = HeldKey(code: code, target: focused.target, token: focused.token, modifier: true)
      return
    }
    var modifiers = Set<KeyModifier>()
    if event.flags.contains(.maskCommand) { modifiers.insert(.cmd) }
    if event.flags.contains(.maskControl) { modifiers.insert(.ctrl) }
    if event.flags.contains(.maskAlternate) { modifiers.insert(.alt) }
    if event.flags.contains(.maskShift) { modifiers.insert(.shift) }
    let raw = event.key == "Delete" ? "forwarddelete" : event.key == " " ? "space" : event.key!
    let normalized = try KeyComboParser.parse(raw).key
    let combo = KeyCombo(modifiers: modifiers, key: normalized)
    // Clipboard operations are explicit AX copy/literal insertion. A forged
    // native clipboard chord must never reach the target's general pasteboard.
    if modifiers.contains(.cmd), ["c", "x", "v"].contains(normalized) { throw MacOwnerInput.Refusal("unsupported") }
    guard !["Dead", "Process", "Unidentified"].contains(event.key!),
      let code = await VirtualKeys.code(for: combo) ?? (event.text != nil ? 0 : nil) else { throw MacOwnerInput.Refusal("unsupported") }
    let target = keys[identity]?.target ?? focused.target
    if keys[identity] != nil, event.repeat != true { throw MacOwnerInput.Refusal("stale") }
    if try await menuShortcut(combo, target: target, lease: lease, map: map, proceed: proceed) {
      keys[identity] = HeldKey(code: code, target: target, token: focused.token, menuHandled: true)
      return
    }
    if event.text != nil, modifiers.isSubset(of: [.shift]) {
      refresh(focused, agentRevision: lease.mutations.agentRevision)
    }
    try await SyntheticEvents.ownerKey(down: true, virtualKey: code, flags: event.flags,
      text: event.text ?? VirtualKeys.characters(for: combo), repeatKey: event.repeat ?? false,
      target: target, gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
    if let text = event.text, modifiers.isSubset(of: [.shift]) {
      predictInsertion(text)
    }
    keys[identity] = HeldKey(code: code, target: target, token: focused.token,
      characters: event.text ?? VirtualKeys.characters(for: combo))
  }

  private func chord(_ combo: KeyCombo, target: EventTarget, lease: MacOwnerAttachment,
                     map: MacOwnerInputMap, proceed: @escaping @Sendable () throws -> Void) async throws {
    if try await menuShortcut(combo, target: target, lease: lease, map: map, proceed: proceed) { return }
    guard let code = await VirtualKeys.code(for: combo) else { throw MacOwnerInput.Refusal("unsupported") }
    try await SyntheticEvents.press(virtualKey: code, flags: combo.flags, characters: VirtualKeys.characters(for: combo),
      target: target, gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
  }

  private func menuShortcut(_ combo: KeyCombo, target: EventTarget, lease: MacOwnerAttachment,
                            map: MacOwnerInputMap, proceed: @escaping @Sendable () throws -> Void) async throws -> Bool {
    let route = try await shortcutPolicy.route(combo, pid: target.processIdentifier, checkGate: {
      try proceed(); try lease.check(map)
    })
    let snap = shortcutPolicy.diagnosticSnapshot
    switch route {
    case .menuItem(let item):
      // A background app may receive the key without running its menu equivalent.
      // Choose its native menu action before effect; never also post or retry it.
      try proceed(); try lease.check(map)
      let status: AXError
      if target.processIdentifier == getpid() {
        let token = AXWindowToken(element: item)
        status = try await MainActor.run {
          try Self.beginAXWrite(token.element) { try proceed(); try lease.check(map) }
          return AXUIElementPerformAction(token.element, kAXPressAction as CFString)
        }
      } else {
        try Self.beginAXWrite(item) { try proceed(); try lease.check(map) }
        status = AXUIElementPerformAction(item, kAXPressAction as CFString)
      }
      if let error = ActionRunner.pressOutcome(status, whatMayHaveHappened: "the shortcut ran",
        failure: "This app's menu did not accept that shortcut.") { throw error }
      MacVideoDiagnostic.write(["event": "owner-menu-shortcut-hit", "streamId": lease.streamID,
        "combo": MenuShortcutIndex.key(for: combo), "shortcuts": snap?.shortcuts ?? [],
        "disabled": snap?.disabled ?? [], "complete": snap?.complete ?? false,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      shortcutPolicy.invalidate()
      return true
    case .disabled:
      MacVideoDiagnostic.write(["event": "owner-menu-shortcut-disabled", "streamId": lease.streamID,
        "combo": MenuShortcutIndex.key(for: combo), "shortcuts": snap?.shortcuts ?? [],
        "disabled": snap?.disabled ?? [], "complete": snap?.complete ?? false,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      return true
    case .keystroke:
      if !combo.modifiers.isDisjoint(with: [.cmd, .ctrl, .alt]) {
        MacVideoDiagnostic.write(["event": "owner-menu-shortcut-miss", "streamId": lease.streamID,
          "combo": MenuShortcutIndex.key(for: combo), "shortcuts": snap?.shortcuts ?? [],
          "disabled": snap?.disabled ?? [], "complete": snap?.complete ?? false,
          "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      }
      return false
    }
  }

  private struct FocusPending: Error {}

  private func keyboardAfterClick(_ lease: MacOwnerAttachment, map: MacOwnerInputMap,
                                  proceed: () throws -> Void) async throws -> Focused {
    while true {
      try proceed()
      do {
        let focused = try keyboard(lease, map: map,
          waitsForClick: ProcessInfo.processInfo.systemUptime < focusAfterClickUntil)
        focusAfterClickUntil = 0
        return focused
      } catch is FocusPending {
        // Safari can publish AX focus after its page has already received the click.
        try await Task.sleep(nanoseconds: 10_000_000)
      }
    }
  }

  private struct Focused { let element: AXUIElement; let target: EventTarget; let secure: Bool; let role: String; let token: AXWindowToken }
  private func keyboard(_ lease: MacOwnerAttachment, map: MacOwnerInputMap, secureMetadata: Bool = false,
                        waitsForClick: Bool = false) throws -> Focused {
    try lease.check(map, secureMetadata: secureMetadata)
    let app = AXUIElementCreateApplication(lease.binding.target.process.processIdentifier)
    guard OwnerInputAXBudget.prepare(app) else { throw MacOwnerInput.Refusal("unavailable") }
    var value: CFTypeRef?
    let status = OwnerInputAXBudget.received(
      AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value))
    let field = try Self.focusedElement(status, value: value, waitsForClick: waitsForClick)
    var pid: pid_t = 0
    guard AXUIElementGetPid(field, &pid) == .success, pid == lease.binding.target.process.processIdentifier,
      let window = AXValueReader.copyElement(field, kAXWindowAttribute), let id = KeyWindow.windowID(of: window),
      map.windows.contains(where: { $0.windowID == id }) else { throw MacOwnerInput.Refusal("stale") }
    let role = AXValueReader.copyString(field, kAXRoleAttribute) ?? ""
    let subrole = AXValueReader.copyString(field, kAXSubroleAttribute)
    return Focused(element: field, target: EventTarget(processIdentifier: pid, windowID: id),
      secure: ActionReceipt.isSecure(role: role, subrole: subrole), role: role, token: AXWindowToken(element: window))
  }

  nonisolated static func focusedElement(_ status: AXError, value: CFTypeRef?, waitsForClick: Bool) throws -> AXUIElement {
    if status == .cannotComplete { throw MacOwnerInput.Refusal("unavailable") }
    if status == .noValue, waitsForClick { throw FocusPending() }
    guard status == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
      throw MacOwnerInput.Refusal("no-field")
    }
    return unsafeBitCast(value, to: AXUIElement.self)
  }

  private func token(for target: EventTarget, lease: MacOwnerAttachment) throws -> AXWindowToken {
    if target.windowID == lease.binding.target.windowID { return AXWindowToken(element: lease.binding.window.element) }
    let app = AXUIElementCreateApplication(target.processIdentifier)
    let roots = AXValueReader.copyElements(app, kAXWindowsAttribute)
    let candidates = roots + roots.flatMap { AXValueReader.copyElements($0, kAXChildrenAttribute) }
    guard let window = candidates.prefix(128).first(where: { KeyWindow.windowID(of: $0) == target.windowID }) else { throw MacOwnerInput.Refusal("unsupported") }
    return AXWindowToken(element: window)
  }

  private func range(_ field: AXUIElement) -> CFRange? {
    guard let value = AXValueReader.copy(field, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(ax) == .cfRange else { return nil }
    var range = CFRange()
    guard AXValueGetValue(ax, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
    return range
  }
  private func fieldIdentity(for focused: Focused) -> OwnerEditingContexts.FieldIdentity {
    let id: String
    if let prev = focusedField, CFEqual(prev.element, focused.element) {
      id = prev.id
    } else {
      nextFieldID += 1
      id = String(nextFieldID)
    }
    return OwnerEditingContexts.FieldIdentity(
      id: id, kind: focused.role, sensitive: focused.secure, editable: true)
  }
  private static let tailWindow = OwnerEditingContexts.tailWindow

  private func numberOfCharacters(_ field: AXUIElement) -> Int? {
    guard let value = AXValueReader.copy(field, kAXNumberOfCharactersAttribute) as? NSNumber else {
      return nil
    }
    let count = value.intValue
    return count >= 0 ? count : nil
  }

  private func stringSlice(_ field: AXUIElement, location: Int, length: Int) -> String? {
    guard location >= 0, length >= 0 else { return nil }
    if length == 0 { return "" }
    var slice = CFRange(location: location, length: length)
    guard let parameter = AXValueCreate(.cfRange, &slice) else { return nil }
    var value: CFTypeRef?
    guard OwnerInputAXBudget.prepare(field), OwnerInputAXBudget.received(AXUIElementCopyParameterizedAttributeValue(
      field,
      kAXStringForRangeParameterizedAttribute as CFString,
      parameter,
      &value
    )) == .success, let text = value as? String, text.utf16.count == length else {
      return nil
    }
    return text
  }

  /// Reads the bounded lookahead text starting at `location` from AX so `moveForward` predicts
  /// only from what was read, never from what was assumed (A1). Returns `nil` when unreadable.
  private func readNextText(_ field: AXUIElement, from location: Int) -> String? {
    if let total = numberOfCharacters(field) {
      guard location <= total else { return nil }
      if location == total { return "" }
      let count = min(Self.tailWindow, total - location)
      guard let slice = stringSlice(field, location: location, length: count) else { return nil }
      // If a single grapheme cluster fills the entire lookahead window while more text follows,
      // we cannot know its true boundary without assuming; return nil so it rotates safely.
      if let first = slice.first, first.utf16.count == slice.utf16.count, location + count < total {
        return nil
      }
      return slice
    }
    // Fallback when AXNumberOfCharacters is unavailable: require at least 2 UTF-16 units where
    // the first grapheme cluster ends strictly inside the slice so we never split a cluster.
    if let two = stringSlice(field, location: location, length: 2),
       let first = two.first, first.utf16.count < two.utf16.count {
      return two
    }
    return nil
  }

  private func observedState(for focused: Focused) -> OwnerEditingContexts.ObservedState? {
    guard !focused.secure, let selected = range(focused.element) else { return nil }
    let tail: String?
    if selected.location == 0 {
      tail = ""
    } else {
      let count = min(selected.location, Self.tailWindow)
      tail = stringSlice(focused.element, location: selected.location - count, length: count)
    }
    return OwnerEditingContexts.ObservedState(
      location: selected.location,
      length: selected.length,
      text: tail)
  }

  private func predictInsertion(_ text: String) {
    guard let base = contexts.predictedState else { return }
    let nextLocation = base.location + text.utf16.count
    let nextTail = base.text.flatMap { OwnerEditingContexts.trimmedTail($0 + text) }
    contexts.expectOwnEffect(
      OwnerEditingContexts.ObservedState(location: nextLocation, length: 0, text: nextTail))
    pendingTextMutation = true
  }

  private struct PreparedCommandPrediction {
    let nextText: String?
    let selectionEndTail: String?
    let shiftedBackTail: String?
  }

  private func prepareCommandPrediction(
    _ command: String,
    focused: Focused
  ) -> PreparedCommandPrediction {
    guard !focused.secure, !pendingTextMutation, let base = contexts.predictedState else {
      return PreparedCommandPrediction(nextText: nil, selectionEndTail: nil, shiftedBackTail: nil)
    }
    switch command {
    case "moveForward":
      if base.length > 0 {
        let end = base.location + base.length
        let count = min(end, Self.tailWindow)
        let tail = stringSlice(focused.element, location: end - count, length: count)
        return PreparedCommandPrediction(nextText: nil, selectionEndTail: tail, shiftedBackTail: nil)
      }
      return PreparedCommandPrediction(
        nextText: readNextText(focused.element, from: base.location),
        selectionEndTail: nil,
        shiftedBackTail: nil)
    case "moveBackward", "deleteBackward":
      if base.length == 0, base.location > Self.tailWindow, let prior = base.text, let last = prior.last {
        let nextLocation = max(0, base.location - last.utf16.count)
        let count = min(nextLocation, Self.tailWindow)
        let tail = stringSlice(focused.element, location: nextLocation - count, length: count)
        return PreparedCommandPrediction(nextText: nil, selectionEndTail: nil, shiftedBackTail: tail)
      }
      return PreparedCommandPrediction(nextText: nil, selectionEndTail: nil, shiftedBackTail: nil)
    default:
      return PreparedCommandPrediction(nextText: nil, selectionEndTail: nil, shiftedBackTail: nil)
    }
  }

  private func predictCommand(_ command: String, prepared: PreparedCommandPrediction) {
    guard let base = contexts.predictedState else { return }
    switch command {
    case "deleteBackward":
      if base.length > 0 {
        contexts.expectOwnEffect(
          OwnerEditingContexts.ObservedState(location: base.location, length: 0, text: base.text))
      } else if base.location > 0 {
        if let prior = base.text, let last = prior.last {
          let removed = last.utf16.count
          let nextTail = base.location <= Self.tailWindow ? String(prior.dropLast()) : prepared.shiftedBackTail
          contexts.expectOwnEffect(
            OwnerEditingContexts.ObservedState(
              location: max(0, base.location - removed), length: 0, text: nextTail))
        } else {
          contexts.expectOwnEffect(
            OwnerEditingContexts.ObservedState(location: base.location - 1, length: 0, text: nil))
        }
      }
      pendingTextMutation = true
    case "moveBackward":
      if base.length > 0 {
        contexts.expectOwnEffect(
          OwnerEditingContexts.ObservedState(location: base.location, length: 0, text: base.text))
      } else if base.location > 0 {
        if let prior = base.text, let last = prior.last {
          let removed = last.utf16.count
          let nextTail = base.location <= Self.tailWindow ? String(prior.dropLast()) : prepared.shiftedBackTail
          contexts.expectOwnEffect(
            OwnerEditingContexts.ObservedState(
              location: max(0, base.location - removed), length: 0, text: nextTail))
        } else {
          contexts.expectOwnEffect(
            OwnerEditingContexts.ObservedState(location: base.location - 1, length: 0, text: nil))
        }
      }
    case "moveForward":
      contexts.expectMoveForward(
        nextText: prepared.nextText,
        selectionEndTail: prepared.selectionEndTail)
    default:
      break
    }
  }

  private func refresh(_ focused: Focused, agentRevision: Int) {
    let observed = observedState(for: focused)
    let identity = fieldIdentity(for: focused)
    // Rule 5 + P4(b): context changes only when the field changes, an external agent acted, or
    // someone else (or the app) changed the live selection/text — never on our own expected edit
    // effects, key-up, mouse button, scroll, or refusal.
    let agentChanged = contextRevision >= 0 && agentRevision != contextRevision
    contexts.observeState(field: identity, state: observed, forceChanged: agentChanged)
    if !contexts.hasPendingExpected { pendingTextMutation = false }
    contextRevision = agentRevision
    focusedField = (focused.element, focused.role, focused.secure, identity.id)
    selection = observed.map { CFRange(location: $0.location, length: $0.length) }
  }
  /// Checked on this actor: a context read between a dispatch and its effect
  /// is never offered while that or later input is still queued, nor while an
  /// agent mutation holds the app lane.
  func publishUnlessPending(_ lease: MacOwnerAttachment, idle: Bool = false) async {
    guard lease.admission.pendingBatches == 0, keys.isEmpty, buttons.isEmpty,
      !idle || (!lease.burstActive.current && !lease.mutations.agentActive),
      let map = lease.producer.inputMap else { return }
    await publishContext(lease, map: map)
  }
  func publishContext(_ lease: MacOwnerAttachment, map: MacOwnerInputMap) async {
    let budget = OwnerInputAXBudget(deadline: ProcessInfo.processInfo.systemUptime + 0.1, limit: 0.1,
      check: { guard lease.active.current else { throw MacOwnerInput.Refusal("unavailable") } })
    OwnerInputAXBudget.$current.withValue(budget) { readContext(lease, map: map) }
  }

  private func readContext(_ lease: MacOwnerAttachment, map: MacOwnerInputMap) {
    guard lease.active.current else { return }
    do {
      let focused = try keyboard(lease, map: map, secureMetadata: true)
      refresh(focused, agentRevision: lease.mutations.agentRevision)
      var caret: MacOwnerInput.Caret?
      if !focused.secure, var selected = selection {
        selected.length = 0
        if let parameter = AXValueCreate(.cfRange, &selected) {
          var value: CFTypeRef?
          if OwnerInputAXBudget.prepare(focused.element),
            OwnerInputAXBudget.received(AXUIElementCopyParameterizedAttributeValue(focused.element, kAXBoundsForRangeParameterizedAttribute as CFString, parameter, &value)) == .success,
            let value, CFGetTypeID(value) == AXValueGetTypeID() {
            let ax = unsafeBitCast(value, to: AXValue.self)
            var rect = CGRect.zero
            if AXValueGetType(ax) == .cgRect, AXValueGetValue(ax, .cgRect, &rect), map.crop.width > 0, map.crop.height > 0 {
              caret = MacOwnerInput.Caret(x: min(1, max(0, (rect.minX - map.crop.minX) / map.crop.width)),
                y: min(1, max(0, (rect.minY - map.crop.minY) / map.crop.height)), height: min(1, max(0, rect.height / map.crop.height)))
            }
          }
        }
      }
      try lease.check(map, secureMetadata: true)
      contexts.markPublished()
      lease.emit(.init(type: "display.editing", generation: map.generation,
        context: .init(contextId: contextID,
          field: ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(focused.role) || selection != nil
            ? .init(kind: focused.role == "AXWebArea" ? "rich" : "text", multiline: focused.role == "AXTextArea", sensitive: focused.secure) : nil,
          caret: caret)))
    } catch {
      focusedField = nil; selection = nil; pendingTextMutation = false; contexts.observeState(field: nil, state: nil)
      contexts.markPublished()
      lease.emit(.init(type: "display.editing", generation: map.generation,
        context: .init(contextId: contextID, field: nil, caret: nil)))
    }
  }

  private func verifyFocus(_ focused: Focused, lease: MacOwnerAttachment, map: MacOwnerInputMap) throws {
    let current = try keyboard(lease, map: map)
    guard CFEqual(current.element, focused.element), current.role == focused.role,
      current.secure == focused.secure, !current.secure else { throw MacOwnerInput.Refusal("stale") }
  }
  nonisolated static func beginEffect(_ proceed: () throws -> Void) throws {
    try proceed()
    OwnerInputAXBudget.current?.effects?.withLock { $0 = true }
  }

  nonisolated static func beginAXWrite(_ element: AXUIElement, proceed: () throws -> Void) throws {
    try proceed()
    guard OwnerInputAXBudget.prepare(element) else { throw MacOwnerInput.Refusal("unavailable") }
    try beginEffect { try OwnerInputAXBudget.current?.check() }
  }

  private enum InsertRoute { case accessibility, unicode }
  private func insertionRoute(_ focused: Focused, lease: MacOwnerAttachment) throws -> InsertRoute {
    let chromium = ChromiumDetection.isChromiumLike(bundlePath: lease.path, bundleId: lease.binding.target.app.bundleId)
    var settable: DarwinBoolean = false
    let ax = !chromium && OwnerInputAXBudget.prepare(focused.element) && OwnerInputAXBudget.received(AXUIElementIsAttributeSettable(focused.element, kAXSelectedTextAttribute as CFString, &settable)) == .success && settable.boolValue
    guard ax || chromium else { throw MacOwnerInput.Refusal("unsupported") }
    return ax ? .accessibility : .unicode
  }
  private func insert(_ text: String, focused: Focused, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                      route: InsertRoute? = nil, proceed: @escaping @Sendable () throws -> Void) async throws {
    let chosen = try route ?? insertionRoute(focused, lease: lease)
    try verifyFocus(focused, lease: lease, map: map); try proceed(); try lease.check(map)
    if chosen == .accessibility {
      try Self.beginAXWrite(focused.element) { try proceed(); try lease.check(map) }
      guard AXUIElementSetAttributeValue(focused.element, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { throw MacOwnerInput.Refusal("unsupported") }
    } else if text.isEmpty {
      try await chord(try KeyComboParser.parse("delete"), target: focused.target, lease: lease, map: map, proceed: proceed)
    } else {
      // Unicode payloads preserve literal newline/tab; no Return/Tab keycode,
      // no pasteboard and no second route after an uncertain dispatch.
      for chunk in TextChunker.chunks(text, limit: 64) {
        try verifyFocus(focused, lease: lease, map: map)
        try await SyntheticEvents.typeUnicode(chunk, target: focused.target,
          gate: { try Self.beginEffect { try proceed(); try lease.check(map) } })
      }
    }
  }
  /// Bounded wait for a text-naming edit when an app (such as Electron) renders a prior keystroke
  /// after dispatch returns (Rule 3, up to `OwnerEditingContexts.namedTextWait` = 0.5 s).
  nonisolated static func waitForNamedText<Match>(
    isolation: isolated (any Actor)? = #isolation,
    pollIntervalNanoseconds: UInt64 = 10_000_000,
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    checkGate: () throws -> Void = {},
    probe: () -> (sameField: Bool, match: Match?),
    onMismatch: () -> Void
  ) async throws -> Match {
    let started = now()
    while true {
      try checkGate()
      let result = probe()
      let decision = OwnerEditingContexts.namedTextWaitDecision(
        sameField: result.sameField,
        matches: result.match != nil,
        waited: now() - started
      )
      switch decision {
      case .apply:
        if let match = result.match { return match }
        onMismatch()
        throw MacOwnerInput.Refusal("stale")
      case .wait:
        try await Task.sleep(nanoseconds: pollIntervalNanoseconds)
      case .refuseField:
        throw MacOwnerInput.Refusal("stale")
      case .refuseMismatch:
        onMismatch()
        throw MacOwnerInput.Refusal("stale")
      }
    }
  }

  private func edit(_ edit: MacOwnerInput.Edit, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                    proceed: @escaping @Sendable () throws -> Void) async throws {
    let focused = try await keyboardAfterClick(lease, map: map, proceed: proceed)
    guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
    refresh(focused, agentRevision: lease.mutations.agentRevision)
    // Choose and qualify the insertion route before selecting any range.
    let route = try insertionRoute(focused, lease: lease)
    let namedText = !edit.before.isEmpty || !edit.after.isEmpty
    guard contexts.admits(
      edit.contextId,
      kind: namedText ? .named : .relative,
      collapsed: selection?.length == 0
    ) else {
      throw MacOwnerInput.Refusal("stale")
    }
    var namedPrediction: (replaceStart: Int, prefix: String?)?
    if namedText {
      let before = edit.before.utf16.count, after = edit.after.utf16.count
      let expected = Array((edit.before + edit.after).utf16)
      let matched: (parameter: AXValue, location: Int) = try await Self.waitForNamedText(
        checkGate: { try proceed(); try lease.check(map) },
        probe: {
          let sameField = (try? self.verifyFocus(focused, lease: lease, map: map)) != nil
          if sameField, let selected = self.range(focused.element), selected.length == 0, selected.location >= before {
            var replacement = CFRange(location: selected.location - before, length: before + after)
            if let parameter = AXValueCreate(.cfRange, &replacement) {
              var value: CFTypeRef?
              if OwnerInputAXBudget.prepare(focused.element),
                OwnerInputAXBudget.received(AXUIElementCopyParameterizedAttributeValue(focused.element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &value)) == .success,
                let actual = value as? String, Array(actual.utf16) == expected,
                self.range(focused.element)?.location == selected.location,
                self.range(focused.element)?.length == 0 {
                return (sameField: true, match: (parameter: parameter, location: selected.location))
              }
            }
          }
          return (sameField: sameField, match: nil)
        },
        onMismatch: {
          self.pendingTextMutation = false
          self.contexts.mismatch()
        }
      )
      try verifyFocus(focused, lease: lease, map: map); try proceed(); try lease.check(map)
      // A1: read the prefix needed to predict the post-replacement tail directly from AX before
      // modifying the field, so verified replacements past the 16-unit tail window keep context.
      let replaceStart = matched.location - before
      let textUnits = edit.text.utf16.count
      let prefix: String?
      if textUnits >= Self.tailWindow {
        prefix = ""
      } else {
        let prefixCount = min(replaceStart, Self.tailWindow - textUnits)
        prefix = stringSlice(focused.element, location: replaceStart - prefixCount, length: prefixCount)
      }
      namedPrediction = (replaceStart: replaceStart, prefix: prefix)
      try Self.beginAXWrite(focused.element) { try proceed(); try lease.check(map) }
      guard AXUIElementSetAttributeValue(focused.element, kAXSelectedTextRangeAttribute as CFString, matched.parameter) == .success else {
        pendingTextMutation = false
        contexts.mismatch()
        throw MacOwnerInput.Refusal("stale")
      }
    }
    try await insert(edit.text, focused: focused, lease: lease, map: map, route: route, proceed: proceed)
    if let namedPrediction {
      contexts.expectNamedReplacement(
        replaceStart: namedPrediction.replaceStart,
        text: edit.text,
        prefixBeforeReplacement: namedPrediction.prefix)
      pendingTextMutation = true
    } else {
      predictInsertion(edit.text)
    }
  }
  private func copy(contextId: String, sequence: Int, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                    proceed: () throws -> Void) async throws {
    let focused = try await keyboardAfterClick(lease, map: map, proceed: proceed)
    guard !focused.secure else {
      throw MacOwnerInput.Refusal("sensitive")
    }
    refresh(focused, agentRevision: lease.mutations.agentRevision)
    guard contexts.admits(contextId, kind: .relative) else {
      throw MacOwnerInput.Refusal("stale")
    }
    guard let selected = range(focused.element) else { throw MacOwnerInput.Refusal("unsupported") }
    try proceed(); try lease.check(map)
    if selected.length == 0 { lease.emit(.init(type: "display.clipboard", sequence: sequence, outcome: "empty")); return }
    guard selected.length <= 30_000 else {
      throw MacOwnerInput.Refusal("too-large")
    }
    guard let text = AXValueReader.copyString(focused.element, kAXSelectedTextAttribute), text.utf16.count <= 30_000 else { throw MacOwnerInput.Refusal("unsupported") }
    try verifyFocus(focused, lease: lease, map: map)
    try proceed(); try lease.check(map)
    lease.count(text.isEmpty ? "clipboard.empty" : "clipboard.copied")
    lease.emit(.init(type: "display.clipboard", sequence: sequence, outcome: text.isEmpty ? "empty" : "copied", text: text.isEmpty ? nil : text))
  }
}
