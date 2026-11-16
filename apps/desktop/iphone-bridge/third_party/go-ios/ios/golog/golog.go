// Package golog is go-ios's internal logging seam. Every go-ios module logs
// through these functions instead of importing a logging library directly.
//
// By default it delegates to slog.Default(), so an importer that does nothing
// sees standard slog behavior. Call ios.SetLogger (which forwards to SetLogger
// here) to route go-ios's logs to your own *slog.Logger — this affects only
// go-ios and never touches the process-global slog.Default().
//
// The level functions capture the *caller's* program counter, so a handler with
// AddSource: true reports the real callsite (e.g. ios/tunnel/tunnel.go) rather
// than this wrapper. The cost matches calling slog directly: one runtime.Callers
// and no extra allocation.
package golog

import (
	"context"
	"log/slog"
	"runtime"
	"sync/atomic"
	"time"
)

// LevelTrace is below slog.LevelDebug, used for the most verbose go-ios logs
// (the CLI's --trace flag). slog has no native trace level.
const LevelTrace slog.Level = slog.LevelDebug - 4

// logger holds the go-ios-scoped logger. Nil means "use slog.Default()", so the
// zero state behaves like plain slog without us caching a logger at init time.
var logger atomic.Pointer[slog.Logger]

// SetLogger routes all go-ios logging to l. Passing nil restores the default
// (slog.Default()). Safe to call concurrently.
func SetLogger(l *slog.Logger) { logger.Store(l) }

// L returns the logger go-ios currently logs through.
func L() *slog.Logger {
	if l := logger.Load(); l != nil {
		return l
	}
	return slog.Default()
}

func Trace(msg string, args ...any) { logl(LevelTrace, msg, args...) }
func Debug(msg string, args ...any) { logl(slog.LevelDebug, msg, args...) }
func Info(msg string, args ...any)  { logl(slog.LevelInfo, msg, args...) }
func Warn(msg string, args ...any)  { logl(slog.LevelWarn, msg, args...) }
func Error(msg string, args ...any) { logl(slog.LevelError, msg, args...) }

// Enabled reports whether the current logger would emit at the given level.
// Useful to guard expensive log-argument construction.
func Enabled(level slog.Level) bool {
	return L().Enabled(context.Background(), level)
}

// logl emits a record at level, capturing the caller's PC (not this wrapper's)
// so AddSource handlers point at the real callsite. Standard slog-wrapper recipe.
func logl(level slog.Level, msg string, args ...any) {
	l := L()
	ctx := context.Background()
	if !l.Enabled(ctx, level) {
		return
	}
	var pcs [1]uintptr
	// skip: runtime.Callers, logl, and the exported wrapper (Info/Debug/…).
	runtime.Callers(3, pcs[:])
	r := slog.NewRecord(time.Now(), level, msg, pcs[0])
	r.Add(args...)
	_ = l.Handler().Handle(ctx, r)
}
