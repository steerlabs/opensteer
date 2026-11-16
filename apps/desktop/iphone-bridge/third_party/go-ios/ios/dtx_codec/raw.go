package dtx

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"time"

	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
)

const logModule = "go-ios/dtx_codec"
const maxMessageSize = 16 << 20

var ErrFrame = errors.New("invalid or oversized DTX frame")

type RawConnection struct {
	conn     net.Conn
	messages int
	bytes    int
}

func NewRawConnection(conn net.Conn) *RawConnection         { return &RawConnection{conn: conn} }
func (c *RawConnection) Close() error                       { return c.conn.Close() }
func (c *RawConnection) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *RawConnection) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
func (c *RawConnection) Send(b []byte) error {
	for len(b) > 0 {
		n, e := c.conn.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func (c *RawConnection) Read() (Message, error) {
	header := make([]byte, 32)
	if _, e := io.ReadFull(c.conn, header); e != nil {
		return Message{}, e
	}
	if binary.BigEndian.Uint32(header) != DtxMessageMagic || binary.LittleEndian.Uint32(header[4:]) != 32 {
		return Message{}, ErrFrame
	}
	length := int(binary.LittleEndian.Uint32(header[12:]))
	fragments := binary.LittleEndian.Uint16(header[10:])
	index := binary.LittleEndian.Uint16(header[8:])
	if length < 16 || length > maxMessageSize || fragments < 1 || fragments > 256 || index != 0 {
		return Message{}, ErrFrame
	}
	c.messages++
	c.bytes += 32 + length
	if c.messages > 4096 || c.bytes > maxMessageSize {
		return Message{}, ErrFrame
	}
	body := make([]byte, length)
	if fragments == 1 {
		if _, e := io.ReadFull(c.conn, body); e != nil {
			return Message{}, e
		}
	} else {
		offset := 0
		for i := uint16(1); i < fragments; i++ {
			part := make([]byte, 32)
			if _, e := io.ReadFull(c.conn, part); e != nil {
				return Message{}, e
			}
			if binary.BigEndian.Uint32(part) != DtxMessageMagic || binary.LittleEndian.Uint32(part[4:]) != 32 || binary.LittleEndian.Uint16(part[8:]) != i || binary.LittleEndian.Uint16(part[10:]) != fragments || !bytes.Equal(part[16:28], header[16:28]) {
				return Message{}, ErrFrame
			}
			n := int(binary.LittleEndian.Uint32(part[12:]))
			if n < 1 || n > length-offset {
				return Message{}, ErrFrame
			}
			c.messages++
			c.bytes += 32
			if c.messages > 4096 || c.bytes > maxMessageSize {
				return Message{}, ErrFrame
			}
			if _, e := io.ReadFull(c.conn, body[offset:offset+n]); e != nil {
				return Message{}, e
			}
			offset += n
		}
		if offset != length {
			return Message{}, ErrFrame
		}
	}
	m := Message{Identifier: int(binary.LittleEndian.Uint32(header[16:])), ConversationIndex: int(binary.LittleEndian.Uint32(header[20:])), ChannelCode: int(binary.LittleEndian.Uint32(header[24:])), ExpectsReply: binary.LittleEndian.Uint32(header[28:]) == 1, MessageLength: length, Fragments: 1, RawBytes: body}
	ph := PayloadHeader{MessageType: MessageType(binary.LittleEndian.Uint32(body)), AuxiliaryLength: binary.LittleEndian.Uint32(body[4:]), TotalPayloadLength: binary.LittleEndian.Uint32(body[8:]), Flags: binary.LittleEndian.Uint32(body[12:])}
	if ph.Flags != 0 || uint64(ph.TotalPayloadLength) != uint64(length-16) || ph.AuxiliaryLength > ph.TotalPayloadLength || ph.MessageType == LZ4CompressedMessage {
		return Message{}, ErrFrame
	}
	m.PayloadHeader = ph
	offset := 16
	if ph.AuxiliaryLength > 0 {
		n := int(ph.AuxiliaryLength)
		if n < 16 || binary.LittleEndian.Uint32(body[16:]) != 496 || binary.LittleEndian.Uint32(body[24:]) != uint32(n-16) {
			return Message{}, ErrFrame
		}
		data := body[32 : 16+n]
		check := data
		for len(check) > 0 {
			typ, _, rest, e := readEntry(check)
			if e != nil || typ != t_null {
				return Message{}, ErrFrame
			}
			typ, _, rest, e = readEntry(rest)
			if e != nil || (typ != t_bytearray && typ != t_uint32 && typ != t_int64) {
				return Message{}, ErrFrame
			}
			check = rest
		}
		m.Auxiliary = DecodeAuxiliary(data)
		offset += n
	}
	if offset < len(body) {
		payload, e := nskeyedarchiver.Unarchive(body[offset:])
		if e != nil {
			return Message{}, e
		}
		m.Payload = payload
	}
	return m, nil
}
func (m Message) PayloadLength() uint32 {
	if m.PayloadHeader.AuxiliaryLength > m.PayloadHeader.TotalPayloadLength {
		return 0
	}
	return m.PayloadHeader.TotalPayloadLength - m.PayloadHeader.AuxiliaryLength
}
func (m Message) HasAuxiliary() bool { return m.PayloadHeader.AuxiliaryLength > 0 }
func (m Message) HasPayload() bool   { return m.PayloadLength() > 0 }
