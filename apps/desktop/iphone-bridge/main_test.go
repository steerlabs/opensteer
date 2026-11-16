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
		command.Env = append(os.Environ(), "OPENSTEER_IPHONE_TEST_CHILD=1")
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
