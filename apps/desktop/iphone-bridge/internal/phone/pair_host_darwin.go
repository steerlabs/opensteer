//go:build darwin

package phone

import (
	"context"
	"os/exec"
	"time"

	"golang.org/x/sys/unix"
)

// computerName is the name shown in System Settings › General › About.
func computerName(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--get", "ComputerName").Output()
	if err != nil || len(out) > 1024 {
		return ""
	}
	return string(out)
}

func hardwareModel() string {
	model, err := unix.Sysctl("hw.model")
	if err != nil {
		return ""
	}
	return model
}
