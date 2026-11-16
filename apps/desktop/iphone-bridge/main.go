package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/phone"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func run() error {
	ios.SetLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &wire.Server{BootID: uuid.New().String()}
	server.Handler = phone.NewManager(ctx, phone.SystemUSB{}, server.Publish)
	return server.Run(ctx, os.Stdin, os.Stdout)
}
func main() {
	// Recover without printing a panic value: native errors may contain private device data.
	defer func() {
		if recover() != nil {
			_, _ = io.WriteString(os.Stderr, "IB_RUNTIME\n")
			os.Exit(1)
		}
	}()
	if err := run(); err != nil {
		_, _ = io.WriteString(os.Stderr, "IB_PROTOCOL\n")
		os.Exit(1)
	}
}
