"""Observe WindowServer metadata and kernel process-exit events without app access."""
print('observer interpreter.start', flush=True)
print('observer import.start', flush=True)
import ctypes as c
import errno
import select
import sys
import time


def trace(phase, deadline=None, **fields):
    remaining = None if deadline is None else deadline - time.monotonic()
    print(f'observer {phase} monotonic={time.monotonic()} remaining={remaining} '
          + ' '.join(f'{key}={value}' for key, value in fields.items()), flush=True)


trace('import.end', executable=sys.executable, version=sys.version.split()[0])


def has_visible_window(pid, deadline=None):
    trace('dlopen.start', deadline, pid=pid, framework='CoreGraphics')
    cg = c.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    trace('dlopen.end', deadline, pid=pid, framework='CoreGraphics')
    trace('dlopen.start', deadline, pid=pid, framework='CoreFoundation')
    cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    trace('dlopen.end', deadline, pid=pid, framework='CoreFoundation')
    cg.CGWindowListCopyWindowInfo.argtypes = [c.c_uint32, c.c_uint32]
    cg.CGWindowListCopyWindowInfo.restype = c.c_void_p
    cf.CFArrayGetCount.argtypes = [c.c_void_p]
    cf.CFArrayGetCount.restype = c.c_long
    cf.CFArrayGetValueAtIndex.argtypes = [c.c_void_p, c.c_long]
    cf.CFArrayGetValueAtIndex.restype = c.c_void_p
    cf.CFDictionaryGetValue.argtypes = [c.c_void_p, c.c_void_p]
    cf.CFDictionaryGetValue.restype = c.c_void_p
    cf.CFNumberGetValue.argtypes = [c.c_void_p, c.c_long, c.c_void_p]
    cf.CFNumberGetValue.restype = c.c_bool
    cf.CFRelease.argtypes = [c.c_void_p]
    cf.CFRelease.restype = None

    def number(window, key, kind, storage):
        value = cf.CFDictionaryGetValue(window, c.c_void_p.in_dll(cg, key).value)
        output = storage()
        if not value or not cf.CFNumberGetValue(value, kind, c.byref(output)):
            return None
        return output.value

    trace('query.start', deadline, pid=pid)
    windows = cg.CGWindowListCopyWindowInfo(1 | 16, 0)
    trace('query.end', deadline, pid=pid)
    if not windows:
        raise RuntimeError('WindowServer did not return window metadata')
    try:
        count = cf.CFArrayGetCount(windows)
        # Stdout is bounded, so other processes' windows are summarized once per poll.
        visible = set()
        for index in range(count):
            window = cf.CFArrayGetValueAtIndex(windows, index)
            owner = number(window, 'kCGWindowOwnerPID', 4, c.c_longlong)
            layer = number(window, 'kCGWindowLayer', 4, c.c_longlong)
            alpha = number(window, 'kCGWindowAlpha', 6, c.c_double)
            if layer == 0 and (alpha or 0) > 0 and owner is not None:
                visible.add(owner)
            if owner == pid:
                trace('window.candidate', deadline, pid=pid, owner=owner, layer=layer, alpha=alpha)
            if owner == pid and layer == 0 and (alpha or 0) > 0:
                trace('window.matched', deadline, pid=pid)
                return True
        trace('window.none', deadline, pid=pid, windows=count,
              visible_owners=','.join(str(owner) for owner in sorted(visible)))
    finally:
        cf.CFRelease(windows)
    return False


def wait_for_window(pid, seconds):
    # WindowServer has no window-appeared event for another process, so observe until the deadline.
    deadline = time.monotonic() + seconds
    trace('window.start', deadline, pid=pid, seconds=seconds)
    while not has_visible_window(pid, deadline):
        if time.monotonic() >= deadline:
            trace('window.deadline', deadline, pid=pid)
            raise RuntimeError(f'No visible loaded desktop window for launched PID within {seconds}s')
        time.sleep(0.2)


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


if __name__ == '__main__':
    if sys.argv[1] == 'window':
        wait_for_window(int(sys.argv[2]), float(sys.argv[3]))
    elif sys.argv[1] == 'exit':
        wait_for_exits(map(int, sys.argv[2:]))
    else:
        raise ValueError('Expected window PID or exit PIDs')
