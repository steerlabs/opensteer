// Command personal-runtime-launcher is the native entrypoint shim for one Node
// service inside a signed Personal runtime release.
//
// Desktop starts every Personal runtime entrypoint through the bundled process
// supervisor as a plain platform executable with no arguments, and the release
// verifier requires each entrypoint to be real platform code for the exact
// release architecture. A Node service therefore ships a launcher that is built
// once per service with its interpreter and script pinned at release build
// time. The launcher resolves both only relative to its own verified location
// inside the release directory, never from PATH, an environment variable, or
// the working directory, and then replaces itself with the interpreter so the
// supervisor keeps supervising the same process.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Both paths are relative to the directory that holds the launcher and are
// injected with -ldflags when the release bundle is assembled.
var (
	interpreterRelativePath string
	scriptRelativePath      string
)

// interpreterFlags are the Node options every service starts with.
//
// --disable-sigusr1 keeps any process running as this user from opening an
// inspector in a service with a signal. Through one, a same-user program could
// read a service's memory, which holds the Runner's bridge tokens, and drive
// the desktop's computer use helper without an approval the Host checked.
var interpreterFlags = []string{"--disable-sigusr1"}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "opensteer personal runtime launcher: %v\n", err)
		os.Exit(70)
	}
}

func run() error {
	if interpreterRelativePath == "" || scriptRelativePath == "" {
		return errors.New("launcher was built without a pinned interpreter and script")
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not resolve the launcher location: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("could not resolve the launcher location: %w", err)
	}
	directory := filepath.Dir(resolved)
	interpreter, err := releaseArtifact(directory, interpreterRelativePath)
	if err != nil {
		return err
	}
	script, err := releaseArtifact(directory, scriptRelativePath)
	if err != nil {
		return err
	}
	return exec(interpreter, interpreterArguments(interpreter, script, os.Args[1:]), os.Environ())
}

// interpreterArguments is the interpreter's argv: its own flags, then the
// pinned script, then whatever the supervisor passed the launcher.
func interpreterArguments(interpreter string, script string, arguments []string) []string {
	argv := make([]string, 0, 2+len(interpreterFlags)+len(arguments))
	argv = append(argv, interpreter)
	argv = append(argv, interpreterFlags...)
	argv = append(argv, script)
	return append(argv, arguments...)
}

// releaseArtifact resolves one pinned release-relative path and refuses
// anything that is not a real regular file inside the release directory.
func releaseArtifact(directory string, relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || strings.ContainsRune(relative, '\\') {
		return "", fmt.Errorf("pinned release path %q is not relative", relative)
	}
	candidate := filepath.Join(directory, filepath.FromSlash(relative))
	metadata, err := os.Lstat(candidate)
	if err != nil {
		return "", fmt.Errorf("pinned release artifact %s is missing: %w", candidate, err)
	}
	if !metadata.Mode().IsRegular() {
		return "", fmt.Errorf("pinned release artifact %s is not a regular file", candidate)
	}
	return candidate, nil
}
