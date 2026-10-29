//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os/user"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Whether macOS lets this process open everything the account can.
//
// macOS offers no API for the grant, and attributes the access to the
// responsible app rather than to this helper, so the only honest way to learn
// the answer is to attempt a gated open from inside that app's process tree.
// `~/.Trash` is the probe because it exists for every account and Full Disk
// Access is the only thing that gates it — no folder share, no per-file mode.
//
// Only EPERM answers "no grant": that is TCC's refusal. EACCES would be a
// POSIX mode problem the grant cannot fix, and ENOENT would mean the directory
// this probe is built on is not there, so neither is reported as denied. The
// account's home comes from user.Current, the same source the SSH server uses,
// so the probe and the sessions it describes agree on whose home this is.
func probeFullDiskAccess() (string, error) {
	account, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("resolve the current account: %w", err)
	}
	if account.HomeDir == "" {
		return "", errors.New("the current account has no home directory")
	}
	path := filepath.Join(account.HomeDir, ".Trash")
	descriptor, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err == nil {
		_ = unix.Close(descriptor)
		return fullDiskAccessGranted, nil
	}
	if errors.Is(err, unix.EPERM) {
		return fullDiskAccessDenied, nil
	}
	return "", fmt.Errorf("probe %s: %w", path, err)
}
