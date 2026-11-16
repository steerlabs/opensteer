package phone

import (
	"context"
	"errors"
	"net"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

func dialLAN(ctx context.Context, c NetworkCandidate, port uint16) (net.Conn, error) {
	level, option := unix.IPPROTO_IP, unix.IP_BOUND_IF
	if c.Address.Is6() {
		level, option = unix.IPPROTO_IPV6, unix.IPV6_BOUND_IF
	}
	dialer := net.Dialer{Control: func(_, _ string, raw syscall.RawConn) error {
		var bindErr error
		err := raw.Control(func(fd uintptr) { bindErr = unix.SetsockoptInt(int(fd), level, option, c.Interface.Index) })
		return errors.Join(err, bindErr)
	}}
	return dialer.DialContext(ctx, "tcp", net.JoinHostPort(c.Address.String(), strconv.Itoa(int(port))))
}
