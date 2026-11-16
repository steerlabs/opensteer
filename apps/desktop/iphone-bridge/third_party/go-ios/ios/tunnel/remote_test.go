package tunnel

import (
	"bytes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios/opack"
	"golang.org/x/crypto/chacha20poly1305"
)

type verifyPeer struct {
	record             *RemotePairRecord
	private            ed25519.PrivateKey
	mode               string
	host, peer, secret []byte
	aead               cipher.AEAD
	sends              int
}

func (p *verifyPeer) Send(m map[string]interface{}, _ ...uint32) error {
	p.sends++
	data, err := getChildMap(m, "value", "message", "plain", "_0", "event", "_0", "pairingData", "_0")
	if err != nil {
		return err
	}
	if p.sends == 1 {
		host, err := tlvReader(data["data"].([]byte)).readCoalesced(typePublicKey)
		if err != nil {
			return err
		}
		p.host = host
		key, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		pub, err := ecdh.X25519().NewPublicKey(host)
		if err != nil {
			return err
		}
		p.peer = key.PublicKey().Bytes()
		p.secret, err = key.ECDH(pub)
		if err != nil {
			return err
		}
		p.aead, err = chacha20poly1305.New(deriveRemote(p.secret, "Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info"))
		return err
	}
	encrypted, err := tlvReader(data["data"].([]byte)).readCoalesced(typeEncryptedData)
	if err != nil {
		return err
	}
	plain, err := p.aead.Open(nil, append(make([]byte, 4), []byte("PV-Msg03")...), encrypted, nil)
	if err != nil {
		return err
	}
	id, err := tlvReader(plain).readCoalesced(typeIdentifier)
	if err != nil {
		return err
	}
	signature, err := tlvReader(plain).readCoalesced(typeSignature)
	if err != nil {
		return err
	}
	signed := append(append(append([]byte{}, p.host...), id...), p.peer...)
	if string(id) != p.record.HostIdentifier || !ed25519.Verify(p.record.publicKey(), signed, signature) {
		return ErrRemotePeerProof
	}
	return nil
}
func (p *verifyPeer) ReceiveOnClientServerStream() (map[string]interface{}, error) {
	tlv := newTlvBuffer()
	if p.mode == "revoked" {
		tlv.writeByte(typeState, 2)
		tlv.writeByte(typeError, 4)
	} else if p.sends == 1 {
		tlv.writeByte(typeState, 2)
		tlv.writeData(typePublicKey, p.peer)
		id := []byte(p.record.PeerIdentifier)
		if p.mode == "wrong-id" {
			id = []byte("unrelated-test-peer")
		}
		signed := append(append(append([]byte{}, p.peer...), id...), p.host...)
		signature := ed25519.Sign(p.private, signed)
		if p.mode == "wrong-signature" {
			signature[0] ^= 1
		}
		proof := newTlvBuffer()
		proof.writeData(typeIdentifier, id)
		proof.writeData(typeSignature, signature)
		encrypted := p.aead.Seal(nil, append(make([]byte, 4), []byte("PV-Msg02")...), proof.bytes(), nil)
		if p.mode == "bad-aead" {
			encrypted[0] ^= 1
		}
		if p.mode != "missing-proof" {
			tlv.writeData(typeEncryptedData, encrypted)
		}
	} else {
		tlv.writeByte(typeState, 4)
	}
	return map[string]interface{}{"value": map[string]interface{}{"message": map[string]interface{}{"plain": map[string]interface{}{"_0": map[string]interface{}{"event": map[string]interface{}{"_0": (&pairingData{data: tlv.bytes(), kind: "verifyManualPairing"}).Encode()}}}}}}, nil
}
func testRecord(t *testing.T) (*RemotePairRecord, ed25519.PrivateKey) {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		t.Fatal(err)
	}
	return &RemotePairRecord{UDID: "test-only-physical-phone", HostIdentifier: "test-host", HostSeed: seed, HostIRK: make([]byte, 16), PeerIdentifier: "test-peer", PeerPublicKey: pub, PeerIRK: make([]byte, 16)}, private
}
func TestVerifyRemoteRequiresPeerProofBeforeSigningOrOpeningTunnel(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-id", "wrong-signature", "bad-aead", "missing-proof"} {
		t.Run(mode, func(t *testing.T) {
			record, private := testRecord(t)
			peer := &verifyPeer{record: record, private: private, mode: mode}
			service := &tunnelService{record: record, controlChannel: newControlChannelReadWriter(peer)}
			err := service.verifyPair()
			if mode == "valid" {
				if err != nil || service.cipher == nil || peer.sends != 2 {
					t.Fatalf("valid proof failed: %v", err)
				}
			} else {
				if !errors.Is(err, ErrRemotePeerProof) || service.cipher != nil || peer.sends != 1 {
					t.Fatal("invalid peer obtained host proof or tunnel capability")
				}
			}
		})
	}
}
func TestPairSetupBindsSignedPeerInfoToPhysicalIdentity(t *testing.T) {
	r, private := testRecord(t)
	sessionKey := []byte("synthetic-session-key")
	info, err := opack.Encode(map[string]interface{}{"altIRK": []byte("0123456789abcdef"), "remotepairing_udid": r.UDID})
	if err != nil {
		t.Fatal(err)
	}
	signed := append(append(deriveRemote(sessionKey, "Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info"), []byte(r.PeerIdentifier)...), r.PeerPublicKey...)
	payload := newTlvBuffer()
	payload.writeData(typeIdentifier, []byte(r.PeerIdentifier))
	payload.writeData(typePublicKey, r.PeerPublicKey)
	payload.writeData(typeSignature, ed25519.Sign(private, signed))
	payload.writeData(typeInfo, info)
	if err := r.acceptPeer(sessionKey, payload.bytes()); err != nil {
		t.Fatal(err)
	}
	r.UDID = "other-test-phone"
	if err := r.acceptPeer(sessionKey, payload.bytes()); !errors.Is(err, ErrRemotePeerProof) {
		t.Fatal("peer from another physical phone accepted")
	}
}
func TestRemoteTLVRejectsTruncatedLength(t *testing.T) {
	if _, err := tlvReader([]byte{byte(typePublicKey)}).readCoalesced(typePublicKey); err == nil {
		t.Fatal("truncated TLV accepted")
	}
}

type memoryRemoteConn struct {
	reader  *bytes.Reader
	written bytes.Buffer
}

func (c *memoryRemoteConn) Read(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return c.reader.Read(p)
}
func (c *memoryRemoteConn) Write(p []byte) (int, error)      { return c.written.Write(p) }
func (c *memoryRemoteConn) Close() error                     { return nil }
func (c *memoryRemoteConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *memoryRemoteConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *memoryRemoteConn) SetDeadline(time.Time) error      { return nil }
func (c *memoryRemoteConn) SetReadDeadline(time.Time) error  { return nil }
func (c *memoryRemoteConn) SetWriteDeadline(time.Time) error { return nil }
func TestRemotePairingSocketSplitCoalescedFramesAndSequenceFence(t *testing.T) {
	body := func(sequence int) []byte {
		b, _ := json.Marshal(map[string]interface{}{"originatedBy": "device", "sequenceNumber": sequence, "message": map[string]interface{}{"streamEncrypted": map[string]interface{}{"_0": "AQID"}}})
		return append(append([]byte("RPPairing"), byte(len(b)>>8), byte(len(b))), b...)
	}
	data := append(body(1), body(2)...)
	data = append(data, body(2)...)
	conn := &memoryRemoteConn{reader: bytes.NewReader(data)}
	socket := &remoteSocket{Conn: conn}
	for range 2 {
		m, err := socket.ReceiveOnClientServerStream()
		if err != nil {
			t.Fatal(err)
		}
		encrypted, err := getChildMap(m, "value", "message", "streamEncrypted")
		if err != nil || !bytes.Equal(encrypted["_0"].([]byte), []byte{1, 2, 3}) {
			t.Fatal("remote socket did not preserve binary payload")
		}
	}
	if _, err := socket.ReceiveOnClientServerStream(); err == nil {
		t.Fatal("replayed remote control sequence accepted")
	}
	for _, bad := range [][]byte{[]byte("notmagic\x00\x01x"), []byte("RPPairing\x00\x00"), body(1)[:12]} {
		socket := &remoteSocket{Conn: &memoryRemoteConn{reader: bytes.NewReader(bad)}}
		if _, err := socket.ReceiveOnClientServerStream(); err == nil {
			t.Fatal("malformed remote frame accepted")
		}
	}
}

func TestRemoteRevokedPairRequiresExplicitSetup(t *testing.T) {
	r, private := testRecord(t)
	peer := &verifyPeer{record: r, private: private, mode: "revoked"}
	service := &tunnelService{record: r, controlChannel: newControlChannelReadWriter(peer)}
	if err := service.verifyPair(); !errors.Is(err, ErrRemotePairingRequired) || peer.sends != 1 || service.cipher != nil {
		t.Fatal("revoked pairing did not require explicit setup")
	}
}
