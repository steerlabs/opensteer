package phone

import (
	"context"
	"os"
	"strings"
	"unicode"

	"github.com/danielpaulus/go-ios/ios/tunnel"
)

const pairHostNameMax = 64

// localPairHost is how this Mac introduces itself when the phone records a Wi-Fi pairing,
// so the person recognises it on the phone.
func localPairHost(ctx context.Context) tunnel.PairHost {
	name := cleanPairHostName(computerName(ctx))
	if name == "" {
		host, _ := os.Hostname()
		name = cleanPairHostName(strings.TrimSuffix(host, ".local"))
	}
	if name == "" {
		name = "Mac"
	}
	return tunnel.PairHost{Name: name, Model: cleanPairHostName(hardwareModel())}
}

func cleanPairHostName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if r := []rune(s); len(r) > pairHostNameMax {
		s = string(r[:pairHostNameMax])
	}
	return s
}
