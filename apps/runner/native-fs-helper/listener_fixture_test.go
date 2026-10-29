//go:build linux || darwin

package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// A real TLS ClientHello is enough; do not wait for the plain fixture to speak TLS.
type fixtureHelloConn struct {
	net.Conn
	written    chan struct{}
	wroteHello bool
	once       sync.Once
}

func (connection *fixtureHelloConn) Write(bytes []byte) (int, error) {
	n, err := connection.Conn.Write(bytes)
	connection.once.Do(func() { connection.wroteHello = n > 0 && len(bytes) > 0 && bytes[0] == 0x16; close(connection.written) })
	return n, err
}

func probeFixtureListener(t *testing.T, ctx context.Context, address string) {
	t.Helper()
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetWriteDeadline(deadline)
	}
	_, err = connection.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))
	connection.Close()
	if err != nil {
		t.Fatal(err)
	}
	connection, err = (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := &fixtureHelloConn{Conn: connection, written: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = tls.Client(wrapped, &tls.Config{InsecureSkipVerify: true}).HandshakeContext(ctx)
	}()
	select {
	case <-wrapped.written:
	case <-ctx.Done():
		connection.Close()
		<-done
		t.Fatalf("probe did not write ClientHello: %v", ctx.Err())
	}
	connection.Close()
	<-done
	if !wrapped.wroteHello {
		t.Fatal("probe did not send a TLS ClientHello")
	}
}

// A target's first TCP peer may be a localhost scanner, not the forwarding client.
// The existing test deadline bounds both admission and partial protocol reads.
func acceptFixturePing(ctx context.Context, listener net.Listener) (net.Conn, error) {
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if tcp, ok := listener.(*net.TCPListener); ok {
			if err := tcp.SetDeadline(deadline); err != nil {
				return nil, err
			}
		}
	}
	for {
		connection, err := listener.Accept()
		if err != nil {
			return nil, fmt.Errorf("fixture protocol admission: %w (context: %v)", err, ctx.Err())
		}
		stopRead := context.AfterFunc(ctx, func() { connection.Close() })
		closeCandidate := func() { stopRead(); connection.Close() }
		if deadline, ok := ctx.Deadline(); ok {
			if err := connection.SetReadDeadline(deadline); err != nil {
				closeCandidate()
				continue
			}
		}
		prefix := make([]byte, 4)
		_, err = io.ReadFull(connection, prefix)
		if err != nil {
			closeCandidate()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		if prefix[0] == 0x16 || string(prefix) == "GET " {
			closeCandidate()
			continue
		}
		if string(prefix) != "ping" {
			closeCandidate()
			continue
		}
		if err := connection.SetReadDeadline(time.Time{}); err != nil {
			closeCandidate()
			return nil, err
		}
		stopRead()
		return connection, nil
	}
}
