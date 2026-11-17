//go:build !darwin

package phone

import (
	"context"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"net"
)

func dialLAN(context.Context, NetworkCandidate, uint16) (net.Conn, error) {
	return nil, wire.Fail(wire.WifiTransportUnsupported)
}
