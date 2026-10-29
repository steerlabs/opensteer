//go:build darwin

package main

import "golang.org/x/sys/unix"

const platformContainment = "posix-openat-nofollow"

// Darwin's st_dev is a mount-session identifier, not a durable volume
// identity. APFS can assign a different value to the same volume after a
// reboot, which made an unchanged managed Workspace look replaced. The native
// helper still enforces st_dev containment for every operation; persistence
// uses the directory's stable inode identity on macOS.
func persistentVolumeID(_ uint64) string { return "0" }

func strictOpenAt(directoryFD int, name string, flags int, mode uint32) (int, error) {
	return unix.Openat(directoryFD, name, flags|unix.O_NOFOLLOW, mode)
}

func statModifiedUnixNano(stat unix.Stat_t) int64 {
	return stat.Mtim.Sec*1_000_000_000 + stat.Mtim.Nsec
}

func statChangedUnixNano(stat unix.Stat_t) int64 {
	return stat.Ctim.Sec*1_000_000_000 + stat.Ctim.Nsec
}
