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

  enum Scope {
    /// Events on their way to one process.
    case process(pid_t)
    /// Every event in the login session, as annotated by the window server.
    case session
  }

  private let context: Context
  private let lock = NSLock()
  private var port: CFMachPort?
  private var source: CFRunLoopSource?

  /// Nil when macOS refuses the tap; nothing is then left half-installed.
  init?(
    _ scope: Scope, place: CGEventTapPlacement, options: CGEventTapOptions,
    types: [UInt32], handler: @escaping Handler
  ) {
    context = Context(handler)
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
    EventTapThread.shared.add(source, enabling: created)
  }

  deinit { stop() }

  func stop() {
    lock.lock()
    let port = self.port
    let source = self.source
    self.port = nil
    self.source = nil
    context.stop()
    lock.unlock()
    guard let port else { return }
    CGEvent.tapEnable(tap: port, enable: false)
    CFMachPortInvalidate(port)
    if let source {
      let context = context
      EventTapThread.shared.remove(source) {
        Unmanaged.passUnretained(context).release()
      }
    }
  }

  private static let callback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let context = Unmanaged<Context>.fromOpaque(info).takeUnretainedValue()
    return context.receive(type, event).map { Unmanaged.passUnretained($0) }
  }

  final class Context: @unchecked Sendable {
    private let handler: Handler
    private let lock = NSLock()
    private var stopped = false
    private var port: CFMachPort?

    init(_ handler: @escaping Handler) { self.handler = handler }

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
        if let port { CGEvent.tapEnable(tap: port, enable: true) }
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

  func add(_ source: CFRunLoopSource, enabling port: CFMachPort) {
    perform {
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
      CGEvent.tapEnable(tap: port, enable: true)
    }
  }

  func remove(_ source: CFRunLoopSource, then retired: @escaping () -> Void) {
    perform {
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
      retired()
    }
  }

  private func perform(_ body: @escaping () -> Void) {
    guard let runLoop else { return }
    CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue, body)
    CFRunLoopWakeUp(runLoop)
  }
}
