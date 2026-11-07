import contextlib
import ctypes
import io
from pathlib import Path
import runpy
import types
import unittest
from unittest.mock import patch


class Function:
    def __init__(self, call):
        self.call = call

    def __call__(self, *args):
        return self.call(*args)


class ObserverTest(unittest.TestCase):
    def load(self, query=None):
        windows = [(9, 0, 1), (42, 1, 1), (42, 0, 0), (42, 0, 1)]
        keys = {'kCGWindowOwnerPID': 0, 'kCGWindowLayer': 1, 'kCGWindowAlpha': 2}
        class Pointer:
            def __init__(self, value=None):
                self.value = value

            @classmethod
            def in_dll(cls, library, key):
                return cls(keys[key])

        def read_number(value, kind, output):
            output._obj.value = value[0]
            return True

        cg = types.SimpleNamespace(CGWindowListCopyWindowInfo=Function(query or (lambda *_: windows)))
        cf = types.SimpleNamespace(
            CFArrayGetCount=Function(len),
            CFArrayGetValueAtIndex=Function(lambda array, index: array[index]),
            CFDictionaryGetValue=Function(lambda window, key: (window[key],)),
            CFNumberGetValue=Function(read_number),
            CFRelease=Function(lambda _: None),
        )
        fake = types.SimpleNamespace(**{key: getattr(ctypes, key) for key in
                                      ['c_uint32', 'c_long', 'c_longlong', 'c_double', 'c_bool', 'byref']})
        fake.c_void_p = Pointer
        fake.CDLL = lambda name: cg if 'CoreGraphics' in name else cf
        with patch.dict('sys.modules', ctypes=fake):
            return runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/smoke-desktop-release-observer.py'))

    def test_candidate_metadata_and_query_boundaries(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            observer = self.load()
            observer['wait_for_window'](42, 10)
        trace = output.getvalue()
        for phase in ['interpreter.start', 'import.start', 'import.end', 'dlopen.start',
                      'dlopen.end', 'query.start', 'query.end', 'remaining=',
                      'owner=42 layer=1 alpha=1', 'owner=42 layer=0 alpha=0',
                      'owner=42 layer=0 alpha=1', 'window.matched']:
            self.assertIn(phase, trace)
        self.assertNotIn('owner=9 ', trace)

    def test_unmatched_poll_names_other_visible_owners(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            observer = self.load(lambda *_: [(9, 0, 1), (7, 0, 1), (42, 1, 1), (8, 3, 1)])
            self.assertFalse(observer['has_visible_window'](42))
        self.assertIn('window.none', output.getvalue())
        self.assertIn('windows=4 visible_owners=7,9', output.getvalue())

    def test_keeps_exact_owner_layer_and_alpha_gate(self):
        for window in [(9, 0, 1), (42, 1, 1), (42, 0, 0)]:
            with self.subTest(window=window), contextlib.redirect_stdout(io.StringIO()):
                observer = self.load(lambda *_: [window])
                self.assertFalse(observer['has_visible_window'](42))

    def test_stalled_query_retains_start_without_end(self):
        def interrupted(*_):
            raise RuntimeError('stand-in for a CG call that never returns')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            observer = self.load(interrupted)
            with self.assertRaisesRegex(RuntimeError, 'CG call'):
                observer['wait_for_window'](42, 10)
        self.assertIn('query.start', output.getvalue())
        self.assertNotIn('query.end', output.getvalue())

    def test_python_deadline_has_distinct_marker(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            observer = self.load(lambda *_: [(9, 0, 1)])
            with patch.object(observer['time'], 'monotonic', return_value=100):
                with self.assertRaisesRegex(RuntimeError, 'No visible loaded desktop window'):
                    observer['wait_for_window'](42, 0)
        self.assertIn('window.deadline', output.getvalue())


if __name__ == '__main__':
    unittest.main()
