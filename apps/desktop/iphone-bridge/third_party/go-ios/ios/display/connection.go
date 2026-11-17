package display

import "github.com/google/uuid"

// NewWithConnection consumes an owned, already initialized RemoteXPC channel.
func NewWithConnection(conn xpcConn) *Service {
	return &Service{conn: conn, deviceID: uuid.New().String()}
}
