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
      case "command": guard MacOwnerInput.commands[command ?? ""] != nil else { throw Refusal("unsupported") }
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
private final class OwnerShortcutPolicy {
  private var index: MenuShortcutIndex?
  nonisolated init() {}
  func route(_ combo: KeyCombo, pid: pid_t) throws -> ActionRunner.KeyRoute {
    guard !combo.modifiers.isEmpty else { return .keystroke }
    let index = self.index ?? MenuShortcutIndex()
    self.index = index
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.1)
    return try ActionRunner.keyRoute(index.lookup(combo, applicationElement: app), combo: combo)
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
  private var contextRevision = -1
  private var contextID = UUID().uuidString
  private var element: AXUIElement?
  private var selection: CFRange?
  private var contextUnpublished = false
  private let shortcutPolicy = OwnerShortcutPolicy()

  nonisolated init() {}

  func cleanup(_ lease: MacOwnerAttachment) async {
    let keys = keys, buttons = buttons
    self.keys.removeAll(); self.buttons.removeAll(); element = nil; selection = nil
    contextID = UUID().uuidString
    lease.heldDeadline.withLock { $0 = nil }
    defer { lease.mutations.setHeld(false, attachment: lease.id) }
    guard lease.binding.target.process.isCurrent else { return }
    for key in keys.values where !key.menuHandled {
      guard KeyWindow.windowID(of: key.token.element) == key.target.windowID else { continue }
      try? await SyntheticEvents.ownerKey(down: false, virtualKey: key.code, flags: [], text: nil, repeatKey: false, target: key.target, modifier: key.modifier)
    }
    for (name, held) in buttons {
      let target = held.target
      guard let button = MouseButton(rawValue: name), KeyWindow.windowID(of: held.token.element) == target.windowID else { continue }
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
        // Checked while this batch holds the app's lane, where contacts change.
        guard !lease.mutations.heldByOther(lease.id) else { throw MacOwnerInput.Refusal("contended") }
        try await lease.verifyPath()
        guard lease.active.current, lease.admission.isCurrent(batch.reservation) else { throw MacOwnerInput.Refusal("unavailable") }
        guard let map = lease.producer.inputMap,
          let enforcer = lease.focus.personEnforcer(for: lease.binding.target.process.processIdentifier)
        else { throw MacOwnerInput.Refusal("stale") }
        guard lease.active.current, lease.admission.isCurrent(batch.reservation) else { throw MacOwnerInput.Refusal("unavailable") }
        try lease.check(map)
        enteredFocus = true
        _ = try await enforcer.guardedPerson(window: lease.binding.window.element, prepare: true, keys: true,
          finalCheck: { try lease.check(map) }, check: { try lease.check(map) },
          hasPendingInput: {
            lease.active.current && !lease.guardFailed.current
              && !lease.mutations.hasWaitingInput
              && burst.current.acceptsInput(at: ProcessInfo.processInfo.systemUptime)
              && lease.mailbox.hasPending
          }
        ) { proceed in
          if current.current == nil { current.withLock { $0 = lease.mailbox.pop() } }
          await self.consumeBurst(lease, current: current, burst: burst, proceed: proceed)
        }
        // The quiet wait and focus watch can include an external caret change.
        await publishUnlessPending(lease)
      } catch {
        let refusal = error as? MacOwnerInput.Refusal
        MacVideoDiagnostic.write(["event": "owner-input-preparation-refused", "streamId": lease.streamID,
          "reason": refusal?.reason ?? "focus-guard", "focusEntered": enteredFocus])
        if let pending = current.withLock({ value in defer { value = nil }; return value }) {
          let reason = !lease.active.current || !lease.admission.isCurrent(pending.reservation)
            ? "unavailable" : (error as? MacOwnerInput.Refusal)?.reason ?? "unsupported"
          lease.admission.complete(pending.reservation)
          pending.reply.resume(returning: .init(sequence: pending.params.sequence,
            outcome: reason == "stale" ? "stale" : "refused", reason: reason))
        }
        // Map/security refusals are safe after restoration; focus errors are fatal.
        if refusal == nil { lease.guardFailed.withLock { $0 = true } }
        await cleanup(lease)
      }
      lease.burstActive.withLock { $0 = false }
      lease.mutations.endPerson()
    } while !lease.mailbox.finishIfEmpty()
  }

  private func consumeBurst(_ lease: MacOwnerAttachment, current: Locked<MacOwnerInput.Batch?>,
                            burst: Locked<OwnerInputBurst>,
                            proceed: @escaping @Sendable () throws -> Void) async {
    while let batch = current.withLock({ value in defer { value = nil }; return value }) {
      let gate: @Sendable () throws -> Void = {
        guard ProcessInfo.processInfo.systemUptime < batch.deadline else { throw MacOwnerInput.Refusal("unsupported") }
        try proceed()
      }
      let result = await run(batch.params, lease: lease, reservation: batch.reservation, proceed: gate)
      batch.reply.resume(returning: result)
      if contextUnpublished { await publishUnlessPending(lease) }
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

  func run(_ params: MacOwnerInput.InputParams, lease: MacOwnerAttachment,
           reservation: OwnerInputAdmission.Reservation,
           proceed: @escaping @Sendable () throws -> Void) async -> MacOwnerInput.Result {
    defer { lease.admission.complete(reservation) }
    do {
      guard lease.active.current, lease.admission.isCurrent(reservation) else { throw MacOwnerInput.Refusal("unavailable") }
      guard lease.admission.isCurrent(reservation), let map = lease.producer.inputMap,
        params.geometry == map.generation else { throw MacOwnerInput.Refusal("stale") }
      if generation != map.generation { await cleanup(lease); generation = map.generation }
      try lease.check(map)
      MacVideoDiagnostic.write(["event": "owner-input-admitted", "streamId": lease.streamID,
        "inputSequence": params.sequence, "generation": map.generation,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
      try proceed()
      let changesEditing = MacOwnerInput.changesEditing(params.events, buttonsHeld: !buttons.isEmpty)
      try await dispatch(params, lease: lease, map: map, proceed: proceed)
      if changesEditing {
        lease.mutations.notePersonEdit()
        // Not published from here: input still queued would invalidate it at once.
        contextID = UUID().uuidString
        contextUnpublished = true
      }
      lease.count("outcome.dispatched")
      return MacOwnerInput.Result(sequence: params.sequence, outcome: "dispatched")
    } catch let refusal as MacOwnerInput.Refusal {
      lease.count("refused." + refusal.reason)
      if refusal.reason == "stale" { contextID = UUID().uuidString }
      await cleanup(lease)
      if let map = lease.producer.inputMap { await publishContext(lease, map: map) }
      return MacOwnerInput.Result(sequence: params.sequence,
        outcome: refusal.reason == "stale" ? "stale" : "refused", reason: refusal.reason)
    } catch {
      await cleanup(lease)
      return MacOwnerInput.Result(sequence: params.sequence, outcome: "refused", reason: "unsupported")
    }
  }

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
          target: target, gate: { try proceed(); try lease.check(map) })
      case "key": try await key(event, lease: lease, map: map, proceed: proceed)
      case "command":
        let combo = try KeyComboParser.parse(MacOwnerInput.commands[event.command!]!)
        let target = try keyboard(lease, map: map).target
        try await chord(combo, target: target, lease: lease, map: map, proceed: proceed)
      case "edit": try await edit(event.edit!, lease: lease, map: map, proceed: proceed)
      case "paste": try await insert(event.text!, lease: lease, map: map, proceed: proceed)
      case "copy":
        do { try copy(sequence: params.sequence, lease: lease, map: map) }
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
    if phase == "cancel" { await cleanup(lease); return }
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
      flags: event.flags, gate: { try proceed(); try lease.check(map) })
    if phase == "down", let retained { buttons[name] = HeldButton(target: target, token: retained) }
    if phase == "up" { buttons[name] = nil }
    if phase == "move", let held { buttons[name] = HeldButton(target: target, token: held.token) }
  }

  private func key(_ event: MacOwnerInput.Event, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                   proceed: @escaping @Sendable () throws -> Void) async throws {
    let identity = event.code!, down = event.action == "down"
    if !down {
      guard let held = keys[identity] else { return }
      if held.menuHandled { keys[identity] = nil; return }
      guard KeyWindow.windowID(of: held.token.element) == held.target.windowID else { throw MacOwnerInput.Refusal("stale") }
      try await SyntheticEvents.ownerKey(down: false, virtualKey: held.code, flags: event.flags, text: held.characters,
        repeatKey: false, target: held.target, modifier: held.modifier, gate: { try proceed(); try lease.check(map) })
      keys[identity] = nil
      return
    }
    let focused = try keyboard(lease, map: map)
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
        gate: { try proceed(); try lease.check(map) })
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
    try await SyntheticEvents.ownerKey(down: true, virtualKey: code, flags: event.flags,
      text: event.text ?? VirtualKeys.characters(for: combo), repeatKey: event.repeat ?? false,
      target: target, gate: { try proceed(); try lease.check(map) })
    keys[identity] = HeldKey(code: code, target: target, token: focused.token,
      characters: event.text ?? VirtualKeys.characters(for: combo))
  }

  private func chord(_ combo: KeyCombo, target: EventTarget, lease: MacOwnerAttachment,
                     map: MacOwnerInputMap, proceed: @escaping @Sendable () throws -> Void) async throws {
    if try await menuShortcut(combo, target: target, lease: lease, map: map, proceed: proceed) { return }
    guard let code = await VirtualKeys.code(for: combo) else { throw MacOwnerInput.Refusal("unsupported") }
    try await SyntheticEvents.press(virtualKey: code, flags: combo.flags, characters: VirtualKeys.characters(for: combo),
      target: target, gate: { try proceed(); try lease.check(map) })
  }

  private func menuShortcut(_ combo: KeyCombo, target: EventTarget, lease: MacOwnerAttachment,
                            map: MacOwnerInputMap, proceed: @escaping @Sendable () throws -> Void) async throws -> Bool {
    guard case .menuItem(let item) = try shortcutPolicy.route(combo, pid: target.processIdentifier) else { return false }
    // A background app may receive the key without running its menu equivalent.
    // Choose its native menu action before effect; never also post or retry it.
    try proceed(); try lease.check(map)
    let status: AXError
    if target.processIdentifier == getpid() {
      status = try await MainActor.run {
        try proceed(); try lease.check(map)
        return AXUIElementPerformAction(item, kAXPressAction as CFString)
      }
    } else { status = AXUIElementPerformAction(item, kAXPressAction as CFString) }
    if let error = ActionRunner.pressOutcome(status, whatMayHaveHappened: "the shortcut ran",
      failure: "This app's menu did not accept that shortcut.") { throw error }
    return true
  }

  private struct Focused { let element: AXUIElement; let target: EventTarget; let secure: Bool; let role: String; let token: AXWindowToken }
  private func keyboard(_ lease: MacOwnerAttachment, map: MacOwnerInputMap, secureMetadata: Bool = false) throws -> Focused {
    try lease.check(map, secureMetadata: secureMetadata)
    let app = AXUIElementCreateApplication(lease.binding.target.process.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.1)
    guard let field = AXValueReader.copyElement(app, kAXFocusedUIElementAttribute) else { throw MacOwnerInput.Refusal("no-field") }
    AXUIElementSetMessagingTimeout(field, 0.1)
    var pid: pid_t = 0
    guard AXUIElementGetPid(field, &pid) == .success, pid == lease.binding.target.process.processIdentifier,
      let window = AXValueReader.copyElement(field, kAXWindowAttribute), let id = KeyWindow.windowID(of: window),
      map.windows.contains(where: { $0.windowID == id }) else { throw MacOwnerInput.Refusal("stale") }
    let role = AXValueReader.copyString(field, kAXRoleAttribute) ?? ""
    let subrole = AXValueReader.copyString(field, kAXSubroleAttribute)
    return Focused(element: field, target: EventTarget(processIdentifier: pid, windowID: id),
      secure: ActionReceipt.isSecure(role: role, subrole: subrole), role: role, token: AXWindowToken(element: window))
  }

  private func token(for target: EventTarget, lease: MacOwnerAttachment) throws -> AXWindowToken {
    if target.windowID == lease.binding.target.windowID { return AXWindowToken(element: lease.binding.window.element) }
    let app = AXUIElementCreateApplication(target.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.1)
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
  private func refresh(_ focused: Focused, revision: Int) {
    if revision != contextRevision { contextID = UUID().uuidString }
    contextRevision = revision
    let next = focused.secure ? nil : range(focused.element)
    if element.map({ !CFEqual($0, focused.element) }) ?? true {
      contextID = UUID().uuidString
    } else if selection?.location != next?.location || selection?.length != next?.length {
      contextID = UUID().uuidString
    }
    element = focused.element; selection = next
  }
  /// Checked on this actor: a context read between a dispatch and its effect
  /// is never offered while that or later input is still queued.
  func publishUnlessPending(_ lease: MacOwnerAttachment, idle: Bool = false) async {
    guard lease.admission.pendingBatches == 0, !idle || !lease.burstActive.current,
      let map = lease.producer.inputMap else { return }
    contextUnpublished = false
    await publishContext(lease, map: map)
  }
  func publishContext(_ lease: MacOwnerAttachment, map: MacOwnerInputMap) async {
    guard lease.active.current else { return }
    do {
      let focused = try keyboard(lease, map: map, secureMetadata: true)
      refresh(focused, revision: lease.mutations.revision)
      var caret: MacOwnerInput.Caret?
      if !focused.secure, var selected = selection {
        selected.length = 0
        if let parameter = AXValueCreate(.cfRange, &selected) {
          var value: CFTypeRef?
          if AXUIElementCopyParameterizedAttributeValue(focused.element, kAXBoundsForRangeParameterizedAttribute as CFString, parameter, &value) == .success,
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
      lease.emit(.init(type: "display.editing", generation: map.generation,
        context: .init(contextId: contextID,
          field: ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(focused.role) || selection != nil
            ? .init(kind: focused.role == "AXWebArea" ? "rich" : "text", multiline: focused.role == "AXTextArea", sensitive: focused.secure) : nil,
          caret: caret)))
    } catch {
      element = nil; selection = nil; contextID = UUID().uuidString
      lease.emit(.init(type: "display.editing", generation: map.generation,
        context: .init(contextId: contextID, field: nil, caret: nil)))
    }
  }

  private func verifyFocus(_ focused: Focused, lease: MacOwnerAttachment, map: MacOwnerInputMap) throws {
    let current = try keyboard(lease, map: map)
    guard CFEqual(current.element, focused.element), !current.secure else { throw MacOwnerInput.Refusal("stale") }
  }
  private func insert(_ text: String, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                      proceed: @escaping @Sendable () throws -> Void) async throws {
    let focused = try keyboard(lease, map: map)
    guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
    try await insert(text, focused: focused, lease: lease, map: map, proceed: proceed)
  }
  private enum InsertRoute { case accessibility, unicode }
  private func insertionRoute(_ focused: Focused, lease: MacOwnerAttachment) throws -> InsertRoute {
    let chromium = ChromiumDetection.isChromiumLike(bundlePath: lease.path, bundleId: lease.binding.target.app.bundleId)
    var settable: DarwinBoolean = false
    let ax = !chromium && AXUIElementIsAttributeSettable(focused.element, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue
    guard ax || chromium else { throw MacOwnerInput.Refusal("unsupported") }
    return ax ? .accessibility : .unicode
  }
  private func insert(_ text: String, focused: Focused, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                      route: InsertRoute? = nil, proceed: @escaping @Sendable () throws -> Void) async throws {
    let chosen = try route ?? insertionRoute(focused, lease: lease)
    try verifyFocus(focused, lease: lease, map: map); try proceed(); try lease.check(map)
    if chosen == .accessibility {
      guard AXUIElementSetAttributeValue(focused.element, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { throw MacOwnerInput.Refusal("unsupported") }
    } else if text.isEmpty {
      try await chord(try KeyComboParser.parse("delete"), target: focused.target, lease: lease, map: map, proceed: proceed)
    } else {
      // Unicode payloads preserve literal newline/tab; no Return/Tab keycode,
      // no pasteboard and no second route after an uncertain dispatch.
      for chunk in TextChunker.chunks(text, limit: 64) {
        try verifyFocus(focused, lease: lease, map: map)
        try await SyntheticEvents.typeUnicode(chunk, target: focused.target,
          gate: { try proceed(); try lease.check(map) })
      }
    }
  }
  private func edit(_ edit: MacOwnerInput.Edit, lease: MacOwnerAttachment, map: MacOwnerInputMap,
                    proceed: @escaping @Sendable () throws -> Void) async throws {
    let focused = try keyboard(lease, map: map)
    guard !focused.secure else { throw MacOwnerInput.Refusal("sensitive") }
    refresh(focused, revision: lease.mutations.revision)
    // Choose and qualify the insertion route before selecting any range.
    let route = try insertionRoute(focused, lease: lease)
    guard contextID == edit.contextId, let selected = selection else { throw MacOwnerInput.Refusal("stale") }
    let before = edit.before.utf16.count, after = edit.after.utf16.count
    if before > 0 || after > 0 {
      guard selected.length == 0, selected.location >= before else { throw MacOwnerInput.Refusal("stale") }
      var replacement = CFRange(location: selected.location - before, length: before + after)
      guard let parameter = AXValueCreate(.cfRange, &replacement) else { throw MacOwnerInput.Refusal("stale") }
      var value: CFTypeRef?
      guard AXUIElementCopyParameterizedAttributeValue(focused.element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &value) == .success,
        let actual = value as? String, Array(actual.utf16) == Array((edit.before + edit.after).utf16),
        range(focused.element)?.location == selected.location,
        range(focused.element)?.length == 0 else { throw MacOwnerInput.Refusal("stale") }
      try verifyFocus(focused, lease: lease, map: map); try proceed(); try lease.check(map)
      guard AXUIElementSetAttributeValue(focused.element, kAXSelectedTextRangeAttribute as CFString, parameter) == .success else { throw MacOwnerInput.Refusal("stale") }
    }
    try await insert(edit.text, focused: focused, lease: lease, map: map, route: route, proceed: proceed)
  }
  private func copy(sequence: Int, lease: MacOwnerAttachment, map: MacOwnerInputMap) throws {
    let focused = try keyboard(lease, map: map)
    guard !focused.secure else {
      throw MacOwnerInput.Refusal("sensitive")
    }
    guard let selected = range(focused.element) else { throw MacOwnerInput.Refusal("unsupported") }
    if selected.length == 0 { lease.emit(.init(type: "display.clipboard", sequence: sequence, outcome: "empty")); return }
    guard selected.length <= 30_000 else {
      throw MacOwnerInput.Refusal("too-large")
    }
    guard let text = AXValueReader.copyString(focused.element, kAXSelectedTextAttribute), text.utf16.count <= 30_000 else { throw MacOwnerInput.Refusal("unsupported") }
    try verifyFocus(focused, lease: lease, map: map)
    lease.count(text.isEmpty ? "clipboard.empty" : "clipboard.copied")
    lease.emit(.init(type: "display.clipboard", sequence: sequence, outcome: text.isEmpty ? "empty" : "copied", text: text.isEmpty ? nil : text))
  }
}
