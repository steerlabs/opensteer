package media

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"time"
)

const (
	socketMedia      byte = 1
	socketACK        byte = 2
	maxUnackedFrames      = 4
	maxUnackedBytes       = 1024 * 1024
	maxUnackedAge         = 500 * time.Millisecond
)

type pendingACK struct {
	sequence uint64
	size     int
	sent     time.Time
}

type mediaSocket struct {
	conn       *net.UnixConn
	pending    []pendingACK
	totalBytes int
}

func openMediaSocket(path string) (*net.UnixListener, error) {
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func (s *mediaSocket) credit(now time.Time) bool {
	return len(s.pending) < maxUnackedFrames && s.totalBytes < maxUnackedBytes &&
		(len(s.pending) == 0 || now.Sub(s.pending[0].sent) < maxUnackedAge)
}

func (s *mediaSocket) send(sequence uint64, data []byte) error {
	if len(data) > maxEnvelope || len(data) == 0 || s.totalBytes+len(data) > maxUnackedBytes {
		return errors.New("display media exceeds available credit")
	}
	now := time.Now()
	if err := s.conn.SetWriteDeadline(now.Add(100 * time.Millisecond)); err != nil {
		return err
	}
	var prefix [5]byte
	prefix[0] = socketMedia
	binary.BigEndian.PutUint32(prefix[1:], uint32(len(data)))
	buffers := net.Buffers{prefix[:], data}
	if _, err := buffers.WriteTo(s.conn); err != nil {
		return err
	}
	s.totalBytes += len(data)
	s.pending = append(s.pending, pendingACK{sequence, len(data), now})
	return nil
}

func (s *mediaSocket) ack(sequence uint64) {
	if len(s.pending) == 0 || s.pending[0].sequence != sequence {
		return
	}
	s.totalBytes -= s.pending[0].size
	s.pending = s.pending[1:]
}

func (s *mediaSocket) readACK() (uint64, error) {
	var header [5]byte
	if _, err := io.ReadFull(s.conn, header[:]); err != nil {
		return 0, err
	}
	length := binary.BigEndian.Uint32(header[1:])
	if header[0] != socketACK || length == 0 || length > 256 {
		return 0, errors.New("invalid display ACK frame")
	}
	var payload [256]byte
	if _, err := io.ReadFull(s.conn, payload[:length]); err != nil {
		return 0, err
	}
	var message struct {
		Type     string  `json:"type"`
		Sequence *uint64 `json:"sequence"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload[:length]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil || decoder.Decode(new(interface{})) != io.EOF ||
		message.Type != "display.ack" || message.Sequence == nil || *message.Sequence > maxSafeInteger {
		return 0, errors.New("invalid display ACK payload")
	}
	return *message.Sequence, nil
}
