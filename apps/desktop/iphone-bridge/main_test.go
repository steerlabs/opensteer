package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func TestBridgeChild(t *testing.T) {
	if os.Getenv("OPENSTEER_IPHONE_TEST_CHILD") != "1" {
		return
	}
	main()
	os.Exit(0)
}
func TestStderrContainsOnlyDiagnosticCodes(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":1000,"method":"hello","params":{"secret":"SENTINEL_UDID_PAIR_KEY_AX_TYPED_SECRET"}}`,
		`{"kind":"request","protocolVersion":2,"id":1,"timeoutMs":1000,"method":"SENTINEL_UDID_PAIR_KEY_AX_TYPED_SECRET","params":{}}`,
		string([]byte{0xff, 0xfe}),
	} {
		var input bytes.Buffer
		_ = binary.Write(&input, binary.BigEndian, uint32(len(body)))
		input.WriteString(body)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		command := exec.CommandContext(ctx, executable, "-test.run=^TestBridgeChild$")
		command.Env = append(os.Environ(), "OPENSTEER_IPHONE_TEST_CHILD=1", "OPENSTEER_IPHONE_BRIDGE_LOG=")
		command.Stdin = &input
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		err := command.Run()
		cancel()
		if err == nil {
			t.Fatal("invalid protocol succeeded")
		}
		if stdout.Len() != 0 || stderr.String() != "IB_PROTOCOL\n" || strings.Contains(stderr.String(), "SENTINEL") {
			t.Fatalf("unbounded diagnostic: stdout=%q stderr=%q", stdout.String(), stderr.String())
		}
	}
}

func TestShutdownExitsWithStdinStillOpen(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestBridgeChild$")
	command.Env = append(os.Environ(), "OPENSTEER_IPHONE_TEST_CHILD=1", "OPENSTEER_IPHONE_BRIDGE_LOG=")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	for i, method := range []string{"hello", "shutdown"} {
		request := map[string]interface{}{"kind": "request", "protocolVersion": 1, "id": i + 1, "timeoutMs": 1000, "method": method, "params": map[string]interface{}{}}
		if err = wire.WriteFrame(input, request, wire.MaxRequestBytes); err != nil {
			t.Fatal(err)
		}
		if _, err = wire.ReadFrame(output, wire.MaxResponseBytes); err != nil {
			t.Fatal(err)
		}
	}
	if err = command.Wait(); err != nil {
		t.Fatalf("shutdown failed or waited for stdin close: %v %s", err, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("default logging wrote stderr: %s", stderr.String())
	}
}
