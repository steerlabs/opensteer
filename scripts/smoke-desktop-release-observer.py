"""Observe WindowServer metadata and kernel process-exit events without app access."""
import ctypes as c
import errno
import select
import sys
import time


def visible_window(pid):
    cg = c.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cg.CGWindowListCopyWindowInfo.argtypes = [c.c_uint32, c.c_uint32]
    cg.CGWindowListCopyWindowInfo.restype = c.c_void_p
    cf.CFArrayGetCount.argtypes = [c.c_void_p]
    cf.CFArrayGetCount.restype = c.c_long
    cf.CFArrayGetValueAtIndex.argtypes = [c.c_void_p, c.c_long]
    cf.CFArrayGetValueAtIndex.restype = c.c_void_p
    cf.CFDictionaryGetValue.argtypes = [c.c_void_p, c.c_void_p]
    cf.CFDictionaryGetValue.restype = c.c_void_p
    cf.CFNumberGetValue.argtypes = [c.c_void_p, c.c_int, c.c_void_p]
    cf.CFNumberGetValue.restype = c.c_bool
    cf.CFRelease.argtypes = [c.c_void_p]

    def number(window, key, kind, storage):
        value = cf.CFDictionaryGetValue(window, c.c_void_p.in_dll(cg, key).value)
        output = storage()
        if not value or not cf.CFNumberGetValue(value, kind, c.byref(output)):
            return None
        return output.value

    windows = cg.CGWindowListCopyWindowInfo(1 | 16, 0)
    if not windows:
        raise RuntimeError('WindowServer did not return window metadata')
    try:
        for index in range(cf.CFArrayGetCount(windows)):
            window = cf.CFArrayGetValueAtIndex(windows, index)
            if (number(window, 'kCGWindowOwnerPID', 4, c.c_longlong) == pid
                    and number(window, 'kCGWindowLayer', 4, c.c_longlong) == 0
                    and (number(window, 'kCGWindowAlpha', 6, c.c_double) or 0) > 0):
                return
    finally:
        cf.CFRelease(windows)
    raise RuntimeError('No visible loaded desktop window for launched PID')


def wait_for_exits(pids):
    queue = select.kqueue()
    try:
        pending = set()
        for pid in set(pids):
            try:
                queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC,
                    flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                    fflags=select.KQ_NOTE_EXIT)], 0, 0)
                pending.add(pid)
            except OSError as error:
                if error.errno != errno.ESRCH:
                    raise
        print(f"Observing {len(pending)} captured process exits", flush=True)
        deadline = time.monotonic() + 10
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Captured desktop children did not exit within 10 seconds')
            for event in queue.control(None, len(pending), remaining):
                if event.flags & select.KQ_EV_ERROR:
                    raise RuntimeError('Process exit observation failed')
                pending.discard(event.ident)

    finally:
        queue.close()


if sys.argv[1] == 'window':
    visible_window(int(sys.argv[2]))
elif sys.argv[1] == 'exit':
    wait_for_exits(map(int, sys.argv[2:]))
else:
    raise ValueError('Expected window PID or exit PIDs')
