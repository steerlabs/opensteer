//go:build darwin

package main

import "testing"

func TestPersistentVolumeIdentitySurvivesDarwinRemount(t *testing.T) {
	if first, second := persistentVolumeID(16_777_232), persistentVolumeID(16_777_233); first != second {
		t.Fatalf("Darwin mount-session device IDs leaked into persisted identity: %q != %q", first, second)
	}
}
