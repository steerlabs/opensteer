//go:build linux

package main

import (
	"fmt"

	"golang.org/x/sys/unix"
)

const platformContainment = "linux-openat2"

func persistentVolumeID(device uint64) string { return fmt.Sprintf("%d", device) }

func strictOpenAt(directoryFD int, name string, flags int, mode uint32) (int, error) {
	return unix.Openat2(directoryFD, name, &unix.OpenHow{
		Flags: uint64(flags),
		Mode:  uint64(mode),
		Resolve: unix.RESOLVE_BENEATH |
			unix.RESOLVE_NO_MAGICLINKS |
			unix.RESOLVE_NO_SYMLINKS |
			unix.RESOLVE_NO_XDEV,
	})
}

func statModifiedUnixNano(stat unix.Stat_t) int64 {
	return stat.Mtim.Sec*1_000_000_000 + stat.Mtim.Nsec
}

func statChangedUnixNano(stat unix.Stat_t) int64 {
	return stat.Ctim.Sec*1_000_000_000 + stat.Ctim.Nsec
}
