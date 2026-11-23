//go:build !darwin

package phone

import "context"

func computerName(context.Context) string { return "" }
func hardwareModel() string               { return "" }
