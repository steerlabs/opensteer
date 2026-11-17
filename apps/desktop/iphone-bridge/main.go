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
	"github.com/steerlabs/opensteer/iphone-bridge/internal/diagnostic"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/phone"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func run() error {
	logger, logFile, err := diagnostic.Open(os.Getenv("OPENSTEER_IPHONE_BRIDGE_LOG"))
	if err != nil {
		return err
	}
	defer logFile.Close()
	ios.SetLogger(logger)
	slog.SetDefault(logger)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &wire.Server{BootID: uuid.New().String()}
	server.Handler = phone.NewManager(ctx, phone.SystemUSB{}, server.Publish)
	// Go opens Darwin FIFOs without kqueue polling. Register a nonblocking
	// duplicate so Close interrupts the reader even while the parent keeps stdin open.
	fd, err := syscall.Dup(int(os.Stdin.Fd()))
	if err != nil {
		return err
	}
	syscall.CloseOnExec(fd)
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return err
	}
	input := os.NewFile(uintptr(fd), "bridge-stdin")
	defer input.Close()
	return server.Run(ctx, input, os.Stdout)
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
