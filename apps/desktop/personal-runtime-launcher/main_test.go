package main

import (
	"reflect"
	"testing"
)

func TestInterpreterStartsWithoutTheSignalInspector(t *testing.T) {
	got := interpreterArguments("/release/node", "/release/runner.mjs", []string{"--probe"})
	want := []string{"/release/node", "--disable-sigusr1", "/release/runner.mjs", "--probe"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("interpreter arguments = %q, want %q", got, want)
	}
}

func TestInterpreterFlagsPrecedeTheScript(t *testing.T) {
	// Anything after the script is the script's own argv, where Node would
	// never read the flag, so the order is the whole guarantee.
	got := interpreterArguments("/release/node", "/release/host.mjs", nil)
	want := []string{"/release/node", "--disable-sigusr1", "/release/host.mjs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("interpreter arguments = %q, want %q", got, want)
	}
}
