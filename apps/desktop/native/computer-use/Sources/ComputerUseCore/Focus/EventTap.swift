import CoreGraphics
import Foundation

/// One event tap and what it does with each event, on the thread every focus
/// tap shares, so a callback never waits on the work lane and the lane never
/// waits on a callback.
///
/// The handler returns the event to pass it on, or nil to drop it. A tap macOS
/// disables for answering slowly, or for user input, is enabled again: a guard
/// that silently stayed off would leave the person's focus unprotected.
final class EventTap: @unchecked Sendable {
  typealias Handler = (CGEventType, CGEvent) -> CGEvent?

  /// What touches a tap's port once it exists. Real taps use CoreGraphics; a test records the
  /// order on a plain port, which needs no Input Monitoring or Accessibility.
  struct PortOps: Sendable {
    var enable: @Sendable (CFMachPort, Bool) -> Void = { CGEvent.tapEnable(tap: $0, enable: $1) }
    var invalidate: @Sendable (CFMachPort) -> Void = { CFMachPortInvalidate($0) }
  }

  enum Scope {
    /// Events on their way to one process.
    case process(pid_t)
    /// Every event in the login session, as annotated by the window server.
    case session
  }

  private let context: Context
  private let ops: PortOps
  private let lock = NSLock()
  private var port: CFMachPort?
  private var source: CFRunLoopSource?

  /// Nil when macOS refuses the tap; nothing is then left half-installed.
  init?(
    _ scope: Scope, place: CGEventTapPlacement, options: CGEventTapOptions,
    types: [UInt32], handler: @escaping Handler
  ) {
    #if SAFARI_FRONT_KEY_TRACE
    if case .process(let pid) = scope, types.contains(CGEventType.keyDown.rawValue) {
      let lane = "process-\(place.rawValue)-\(options.rawValue)"
      ops = PortOps(
        enable: { port, enabled in
          SafariKeyTapTrace.record(lane + (enabled ? ".enable" : ".disable"), pid: pid)
          CGEvent.tapEnable(tap: port, enable: enabled)
        },
        invalidate: { port in
          SafariKeyTapTrace.record(lane + ".invalidate", pid: pid)
          CFMachPortInvalidate(port)
        })
      context = Context({ type, event in
        let result = handler(type, event)
        if type == .keyDown {
          SafariKeyTapTrace.record(lane + (result == nil ? ".drop" : ".pass"),
            pid: pid, stamp: event.timestamp)
        }
        return result
      }, ops: ops)
    } else {
      ops = PortOps()
      context = Context(handler, ops: ops)
    }
    #else
    ops = PortOps()
    context = Context(handler, ops: ops)
    #endif
    let mask = types.reduce(CGEventMask(0)) { $0 | (1 << CGEventMask($1)) }
    // The registration, not the EventTap owner, keeps callbacks alive until
    // their run-loop source is removed after any callback already executing.
    let info = Unmanaged.passRetained(context).toOpaque()
    let created: CFMachPort?
    switch scope {
    case .process(let pid):
      created = PrivateAPI.createPidTap?(
        pid, place.rawValue, options.rawValue, mask, Self.callback, info)?.takeRetainedValue()
    case .session:
      created = CGEvent.tapCreate(
        tap: .cgAnnotatedSessionEventTap, place: place, options: options,
        eventsOfInterest: mask, callback: Self.callback, userInfo: info)
    }
    guard let created, let source = CFMachPortCreateRunLoopSource(nil, created, 0) else {
      if let created { CFMachPortInvalidate(created) }
      Unmanaged<Context>.fromOpaque(info).release()
      return nil
    }
    port = created
    context.install(created)
    self.source = source
    EventTapThread.shared.add(source, enabling: created, ops: ops)
  }

  /// A tap over a port made elsewhere, with recorded port operations: the ordering test's seam.
  init(port: CFMachPort, source: CFRunLoopSource, ops: PortOps, handler: @escaping Handler) {
    self.ops = ops
    context = Context(handler, ops: ops)
    _ = Unmanaged.passRetained(context)
    self.port = port
    context.install(port)
    self.source = source
    EventTapThread.shared.add(source, enabling: port, ops: ops)
  }

  deinit { stop() }

  /// Safe from any thread, and twice. The handler is never called once this returns: the
  /// context stops first, so the tap passes events through until it is gone. Everything else
  /// that touches the port (disable, invalidate, removing its source) happens on the tap thread,
  /// behind the add it follows: a tap stopped before its add ran was enabled after its port was
  /// invalidated, and the helper crashed (EXC_BAD_ACCESS in SLEventTapEnable). Nothing waits:
  /// no caller needs more than its handler silenced.
  func stop() {
    lock.lock()
    let port = self.port
    let source = self.source
    self.port = nil
    self.source = nil
    context.stop()
    lock.unlock()
    guard let port, let source else { return }
    let context = context
    EventTapThread.shared.remove(source, port: port, ops: ops) {
      Unmanaged.passUnretained(context).release()
    }
  }

  private static let callback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let context = Unmanaged<Context>.fromOpaque(info).takeUnretainedValue()
    return context.receive(type, event).map { Unmanaged.passUnretained($0) }
  }

  final class Context: @unchecked Sendable {
    private let handler: Handler
    private let ops: PortOps
    private let lock = NSLock()
    private var stopped = false
    private var port: CFMachPort?

    init(_ handler: @escaping Handler, ops: PortOps = PortOps()) {
      self.handler = handler
      self.ops = ops
    }

    func install(_ port: CFMachPort) {
      lock.lock()
      self.port = port
      lock.unlock()
    }

    func stop() {
      lock.lock()
      stopped = true
      port = nil
      lock.unlock()
    }

    func receive(_ type: CGEventType, _ event: CGEvent) -> CGEvent? {
      lock.lock()
      let stopped = stopped
      let port = port
      lock.unlock()
      guard !stopped else { return event }
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let port { ops.enable(port, true) }
        return event
      }
      return handler(type, event)
    }
  }
}

/// The one thread whose run loop serves every focus tap.
final class EventTapThread: @unchecked Sendable {
  static let shared = EventTapThread()

  private var runLoop: CFRunLoop?

  private init() {
    let ready = DispatchSemaphore(value: 0)
    let thread = Thread { [self] in
      runLoop = CFRunLoopGetCurrent()
      // A run loop with no source returns at once; the port keeps it serving.
      RunLoop.current.add(NSMachPort(), forMode: .default)
      ready.signal()
      while true { RunLoop.current.run(mode: .default, before: .distantFuture) }
    }
    thread.name = "com.opensteer.computer-use.focus-taps"
    thread.qualityOfService = .userInteractive
    thread.start()
    ready.wait()
  }

  func add(_ source: CFRunLoopSource, enabling port: CFMachPort, ops: EventTap.PortOps) {
    perform {
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
      ops.enable(port, true)
    }
  }

  /// Runs after every block queued before it, the tap's own add included.
  func remove(
    _ source: CFRunLoopSource, port: CFMachPort, ops: EventTap.PortOps,
    then retired: @escaping () -> Void
  ) {
    perform {
      ops.enable(port, false)
      ops.invalidate(port)
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
      retired()
    }
  }

  func perform(_ body: @escaping () -> Void) {
    guard let runLoop else { return }
    CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue, body)
    CFRunLoopWakeUp(runLoop)
  }
}
