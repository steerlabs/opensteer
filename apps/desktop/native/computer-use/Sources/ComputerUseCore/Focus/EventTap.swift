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

  private let handler: Handler
  private let lock = NSLock()
  private var port: CFMachPort?
  private var source: CFRunLoopSource?

  /// Nil when macOS refuses the tap; nothing is then left half-installed.
  init?(
    _ scope: Scope, place: CGEventTapPlacement, options: CGEventTapOptions,
    types: [UInt32], handler: @escaping Handler
  ) {
    self.handler = handler
    let mask = types.reduce(CGEventMask(0)) { $0 | (1 << CGEventMask($1)) }
    let info = Unmanaged.passUnretained(self).toOpaque()
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
      return nil
    }
    port = created
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
    lock.unlock()
    guard let port else { return }
    CGEvent.tapEnable(tap: port, enable: false)
    CFMachPortInvalidate(port)
    if let source { EventTapThread.shared.remove(source) }
  }

  private static let callback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<EventTap>.fromOpaque(info).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      tap.lock.lock()
      let port = tap.port
      tap.lock.unlock()
      if let port { CGEvent.tapEnable(tap: port, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    return tap.handler(type, event).map { Unmanaged.passUnretained($0) }
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

  func remove(_ source: CFRunLoopSource) {
    perform { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes) }
  }

  private func perform(_ body: @escaping () -> Void) {
    guard let runLoop else { return }
    CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue, body)
    CFRunLoopWakeUp(runLoop)
  }
}
