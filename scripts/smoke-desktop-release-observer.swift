import CoreGraphics
import Darwin
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "window", arguments.count == 2, let pid = Int(arguments[1]) {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let visible = windows.contains { window in
        (window[kCGWindowOwnerPID as String] as? Int) == pid &&
        (window[kCGWindowLayer as String] as? Int) == 0 &&
        (window[kCGWindowAlpha as String] as? Double ?? 0) > 0
    }
    if !visible { fail("No visible desktop window for the launched PID") }
} else if arguments.first == "exit" {
    let descriptor = kqueue()
    if descriptor < 0 { fail("Could not create process exit observer") }
    defer { close(descriptor) }
    var pending = 0
    for argument in Set(arguments.dropFirst()) {
        guard let pid = UInt(argument) else { fail("Invalid process ID") }
        var event = kevent(ident: pid, filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT), fflags: UInt32(NOTE_EXIT), data: 0, udata: nil)
        if kevent(descriptor, &event, 1, nil, 0, nil) == 0 { pending += 1 }
        else if errno != ESRCH { fail("Could not observe process \(pid) exit: \(errno)") }
    }
    let deadline = Date().addingTimeInterval(10)
    while pending > 0 {
        let remaining = deadline.timeIntervalSinceNow
        if remaining <= 0 { fail("Captured desktop children did not exit within 10 seconds") }
        var timeout = timespec(tv_sec: Int(ceil(remaining)), tv_nsec: 0)
        var event = kevent()
        let count = kevent(descriptor, nil, 0, &event, 1, &timeout)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { fail("Captured desktop children did not exit within 10 seconds") }
        if event.flags & UInt16(EV_ERROR) != 0 { fail("Process exit observation failed") }
        pending -= 1
    }
} else {
    fail("Expected window PID or exit PIDs")
}
