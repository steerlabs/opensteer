package tlspsk

import (
	"bytes"
	"crypto/hmac"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func syntheticServer(conn net.Conn, key []byte, badProof bool) error {
	defer conn.Close()
	c := &pskConn{conn: conn}
	kind, hello, err := c.readHandshakeMsg()
	if err != nil {
		return err
	}
	if kind != hsClientHello || len(hello) < 34 {
		return errors.New("missing client hello")
	}
	clientRandom := append([]byte{}, hello[2:34]...)
	serverRandom := bytes.Repeat([]byte{0x42}, 32)
	body := append([]byte{3, 3}, serverRandom...)
	body = append(body, 0, 0, 0xa9, 0)
	if err := c.writeHandshake(handshakeMsg(hsServerHello, body)); err != nil {
		return err
	}
	if err := c.writeHandshake(handshakeMsg(hsServerHelloDone, nil)); err != nil {
		return err
	}
	kind, _, err = c.readHandshakeMsg()
	if err != nil {
		return err
	}
	if kind != hsClientKeyExchange {
		return errors.New("missing client key exchange")
	}
	kind, _, err = c.readRecord()
	if err != nil {
		return err
	}
	if kind != recordChangeCipherSpec {
		return errors.New("missing client cipher change")
	}
	master := prf12(pskPremasterSecret(key), "master secret", append(clientRandom, serverRandom...), masterSecretLen)
	c.setupKeys(master, clientRandom, serverRandom)
	c.readAEAD, c.writeAEAD = c.writeAEAD, c.readAEAD
	c.readIV, c.writeIV = c.writeIV, c.readIV
	c.readEnc = true
	expected := c.verifyData(master, "client finished")
	kind, proof, err := c.readHandshakeMsg()
	if err != nil {
		return err
	}
	if kind != hsFinished || !hmac.Equal(expected, proof) {
		return errors.New("bad client finished")
	}
	if err := c.writeRecord(recordChangeCipherSpec, []byte{1}); err != nil {
		return err
	}
	c.writeEnc = true
	proof = c.verifyData(master, "server finished")
	if badProof {
		proof[0] ^= 1
	}
	if err := c.writeHandshake(handshakeMsg(hsFinished, proof)); err != nil {
		return err
	}
	if badProof {
		return nil
	}
	data := make([]byte, 20000)
	if _, err := io.ReadFull(c, data); err != nil {
		return err
	}
	_, err = c.Write(data)
	return err
}
func TestSyntheticTLSPSKHandshakeRecordsAndPeerFinished(t *testing.T) {
	for _, bad := range []bool{false, true} {
		t.Run(map[bool]string{false: "verified", true: "bad-peer-proof"}[bad], func(t *testing.T) {
			client, server := net.Pipe()
			deadline := time.Now().Add(2 * time.Second)
			_ = client.SetDeadline(deadline)
			_ = server.SetDeadline(deadline)
			defer client.Close()
			key := bytes.Repeat([]byte{0x51}, 32)
			result := make(chan error, 1)
			go func() { result <- syntheticServer(server, key, bad) }()
			c, err := Client(client, key)
			if bad {
				if err == nil {
					t.Fatal("bad server Finished accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer c.Close()
				payload := bytes.Repeat([]byte{0x77}, 20000)
				sent := make(chan error, 1)
				go func() { _, err := c.Write(payload); sent <- err }()
				output := make([]byte, len(payload))
				if _, err := io.ReadFull(c, output); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(output, payload) {
					t.Fatal("encrypted record roundtrip corrupted")
				}
				select {
				case err := <-sent:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Until(deadline)):
					t.Fatal("TLS write never completed")
				}
			}
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Until(deadline)):
				t.Fatal("TLS peer never completed")
			}
		})
	}
}
func TestRejectsUnboundedHandshakeAndWrongServerVersion(t *testing.T) {
	hello := append([]byte{3, 2}, make([]byte, 32)...)
	hello = append(hello, 0, 0, 0xa9, 0)
	if _, err := parseServerHello(hello); err == nil {
		t.Fatal("non TLS-1.2 server accepted")
	}
	var buf bytes.Buffer
	header := []byte{recordHandshake, 3, 3, 0, 4}
	buf.Write(header)
	buf.Write([]byte{hsServerHello, 0xff, 0xff, 0xff})
	c := &pskConn{conn: &byteConn{Reader: &buf}}
	if _, _, err := c.readHandshakeMsg(); err == nil {
		t.Fatal("oversized handshake accepted")
	}
}

type byteConn struct{ io.Reader }

func (c *byteConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *byteConn) Close() error                     { return nil }
func (c *byteConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *byteConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *byteConn) SetDeadline(time.Time) error      { return nil }
func (c *byteConn) SetReadDeadline(time.Time) error  { return nil }
func (c *byteConn) SetWriteDeadline(time.Time) error { return nil }
