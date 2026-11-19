package diagnostic

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
)

var secrets = struct {
	sync.RWMutex
	values map[string]bool
}{values: map[string]bool{}}

func Remember(values ...string) {
	secrets.Lock()
	defer secrets.Unlock()
	for _, value := range values {
		if value != "" {
			secrets.values[value] = true
		}
	}
}

var identifiers = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[0-9]{9,})\b`)
var opaque = regexp.MustCompile(`[A-Za-z0-9+/=_-]{64,}`)
var sensitive = regexp.MustCompile(`(?i)udid|unique.?device|serial|ecid|pair.?record|private.?key|public.?key|certificate|BEGIN .*KEY|escrow|host.?id|system.?buid|["']?(?:key|password|token)["']?\s*[:=]`)

func scrub(value string) string {
	// Native errors sometimes format entire personalization/pairing dictionaries.
	// Keep those out in full rather than guessing which nested values are secrets.
	if sensitive.MatchString(value) {
		return "[redacted sensitive native error]"
	}
	secrets.RLock()
	for secret := range secrets.values {
		value = strings.ReplaceAll(value, secret, "[redacted]")
	}
	secrets.RUnlock()
	value = identifiers.ReplaceAllString(value, "[redacted]")
	value = opaque.ReplaceAllString(value, "[redacted]")
	if len(value) > 2048 {
		value = value[:2048] + "…"
	}
	return value
}

func Open(path string) (*slog.Logger, io.Closer, error) {
	// By default diagnostics go to stderr, which the desktop writes to its own rotating log.
	if path == "" {
		return newLogger(os.Stderr), io.NopCloser(strings.NewReader("")), nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, nil, errors.New("cannot open debug log")
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, errors.New("cannot inspect debug log")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) {
		f.Close()
		return nil, nil, errors.New("debug log is not a private regular file")
	}
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return nil, nil, errors.New("cannot restrict debug log")
	}
	return newLogger(f), f, nil
}

func newLogger(w io.Writer) *slog.Logger {
	handler := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		switch a.Key {
		case slog.TimeKey, slog.LevelKey:
			return a
		case slog.MessageKey:
			switch a.Value.String() {
			case "bridge.request", "bridge.response", "bridge.service", "bridge.native-error":
				return a
			}
			return slog.String(a.Key, "native")
		case "method", "service", "reason", "module":
			return slog.String(a.Key, scrub(a.Value.String()))
		case "requestId", "durationMs":
			if a.Value.Kind() == slog.KindInt64 || a.Value.Kind() == slog.KindUint64 {
				return a
			}
			return slog.Attr{}
		case "err", "error":
			return slog.String("nativeError", scrub(a.Value.String()))
		default:
			return slog.Attr{}
		}
	}})
	return slog.New(handler)
}
