package ios

import (
	"log/slog"

	"github.com/danielpaulus/go-ios/ios/golog"
)

// LevelTrace is the slog level go-ios uses for its most verbose logs (below
// slog.LevelDebug). Set it as your handler's level to see trace output.
const LevelTrace = golog.LevelTrace

// SetLogger routes all of go-ios's internal logging to the given *slog.Logger.
//
// This is opt-in: if you never call it, go-ios logs through slog.Default() like
// any other slog-using library. Calling it affects only go-ios — it does not
// change the process-global slog.Default(), so your application's own logging
// is untouched. Pass nil to restore the default.
//
//	ios.SetLogger(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
//		Level: ios.LevelTrace,
//	})))
func SetLogger(l *slog.Logger) { golog.SetLogger(l) }
