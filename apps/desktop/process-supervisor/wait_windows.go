//go:build windows

package main

// Windows never reports which signal ended a target (it has none): every stop counts as sent.
func endedWithoutReaping(_ int) bool {
	return false
}
