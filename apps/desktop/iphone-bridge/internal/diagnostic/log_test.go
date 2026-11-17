package diagnostic

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateStructuredLogScrubsNativeData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "debug.jsonl")
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	logger, closer, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	Remember("SENTINEL_DEVICE", "SERIAL_SENTINEL")
	logger.Debug("bridge.request", "method", "phone.observe", "requestId", 7, "params", map[string]string{"udid": "SENTINEL_DEVICE"})
	logger.Debug("bridge.native-error", "err", errors.New("connect SENTINEL_DEVICE failed: EOF"), "reason", "native-service-failed")
	for _, secret := range []string{"PairRecord=map[HostPrivateKey:SENTINEL_PAIR]", "ECID: 1234567", "serial SERIAL_SENTINEL", "00008150-123456789abcdef0", "-----BEGIN PRIVATE KEY-----SENTINEL_KEY"} {
		logger.Debug("untrusted "+secret, "err", errors.New(secret), "pairRecord", secret, "udid", secret)
	}
	if err = closer.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("permissions: %v %v", info, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"SENTINEL", "1234567", "00008150", "PRIVATE KEY", "pairRecord", "params", "udid"} {
		if strings.Contains(string(data), private) {
			t.Fatalf("private data %q leaked: %s", private, data)
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var event map[string]interface{}
		if json.Unmarshal([]byte(line), &event) != nil {
			t.Fatal("invalid structured log")
		}
	}
	if !strings.Contains(string(data), "phone.observe") || !strings.Contains(string(data), "failed: EOF") {
		t.Fatal("useful diagnostics lost")
	}
}
func TestLogRejectsSymlinksAndHardlinks(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"symlink", "hardlink"} {
		path := filepath.Join(root, kind)
		var err error
		if kind == "symlink" {
			err = os.Symlink(target, path)
		} else {
			err = os.Link(target, path)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, closer, err := Open(path); err == nil {
			closer.Close()
			t.Fatalf("accepted %s", kind)
		}
	}
	data, _ := os.ReadFile(target)
	if string(data) != "keep" {
		t.Fatal("log damaged link target")
	}
}
