package tunnel

import (
	"bytes"
	"context"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"

	"github.com/danielpaulus/go-ios/ios/opack"
	"github.com/danielpaulus/go-ios/ios/tunnel/tlspsk"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"golang.org/x/crypto/hkdf"
)

var ErrRemotePairingRequired = errors.New("remote pairing required")
var ErrRemotePeerProof = errors.New("remote peer proof failed")

// RemotePairRecord belongs only to the app's private store, never to wire status.
type RemotePairRecord struct {
	UDID           string
	HostIdentifier string
	HostSeed       []byte
	HostIRK        []byte
	PeerIdentifier string
	PeerPublicKey  []byte
	PeerIRK        []byte
}

func (r *RemotePairRecord) privateKey() ed25519.PrivateKey { return ed25519.NewKeyFromSeed(r.HostSeed) }
func (r *RemotePairRecord) publicKey() ed25519.PublicKey {
	return r.privateKey().Public().(ed25519.PublicKey)
}
func (r *RemotePairRecord) Valid() bool {
	return r != nil && len(r.UDID) > 0 && len(r.UDID) <= 128 && len(r.HostIdentifier) > 0 && len(r.HostIdentifier) <= 128 && len(r.HostSeed) == 32 && len(r.HostIRK) == 16 && len(r.PeerIdentifier) > 0 && len(r.PeerIdentifier) <= 128 && len(r.PeerPublicKey) == 32 && len(r.PeerIRK) == 16
}
func deriveRemote(key []byte, salt, info string) []byte {
	out := make([]byte, 32)
	_, _ = io.ReadFull(hkdf.New(sha512.New, key, []byte(salt), []byte(info)), out)
	return out
}
func (r *RemotePairRecord) acceptPeer(sessionKey, plain []byte) error {
	tlv := tlvReader(plain)
	id, e1 := tlv.readCoalesced(typeIdentifier)
	pub, e2 := tlv.readCoalesced(typePublicKey)
	signature, e3 := tlv.readCoalesced(typeSignature)
	info, e4 := tlv.readCoalesced(typeInfo)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || len(id) == 0 || len(id) > 128 || len(pub) != 32 {
		return ErrRemotePeerProof
	}
	signed := append(deriveRemote(sessionKey, "Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info"), id...)
	signed = append(signed, pub...)
	if !ed25519.Verify(pub, signed, signature) {
		return ErrRemotePeerProof
	}
	values, err := opack.DecodePairingInfo(info)
	if err != nil {
		return ErrRemotePeerProof
	}
	irk, ok := values["altIRK"].([]byte)
	if !ok || len(irk) != 16 {
		return ErrRemotePeerProof
	}
	if udid, ok := values["remotepairing_udid"].(string); !ok || udid != r.UDID {
		return ErrRemotePeerProof
	}
	r.PeerIdentifier = string(id)
	r.PeerPublicKey = pub
	r.PeerIRK = irk
	return nil
}
func verifyRemotePeer(aead cipher.AEAD, encrypted, peerEphemeral, hostEphemeral []byte, r *RemotePairRecord) error {
	nonce := append(make([]byte, 4), []byte("PV-Msg02")...)
	plain, err := aead.Open(nil, nonce, encrypted, nil)
	if err != nil {
		return ErrRemotePeerProof
	}
	id, err := tlvReader(plain).readCoalesced(typeIdentifier)
	if err != nil || string(id) != r.PeerIdentifier {
		return ErrRemotePeerProof
	}
	signature, err := tlvReader(plain).readCoalesced(typeSignature)
	if err != nil {
		return ErrRemotePeerProof
	}
	signed := append(append(append([]byte{}, peerEphemeral...), id...), hostEphemeral...)
	if !ed25519.Verify(r.PeerPublicKey, signed, signature) {
		return ErrRemotePeerProof
	}
	return nil
}

// PairRemote is called only in explicit USB setup, over an already identity-verified RSD service.
//
// The device may ask its owner to allow the computer; observe reports that so the
// person can be told to look at the phone. host is what the phone records.
func PairRemote(ctx context.Context, conn *xpc.Connection, udid, hostID string, host PairHost, observe func(PairStage)) (*RemotePairRecord, error) {
	r := &RemotePairRecord{UDID: udid, HostIdentifier: hostID, HostSeed: make([]byte, 32), HostIRK: make([]byte, 16)}
	if _, err := rand.Read(r.HostSeed); err != nil {
		return nil, err
	}
	if _, err := rand.Read(r.HostIRK); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	defer conn.Close()
	t := &tunnelService{c: conn, controlChannel: newControlChannelReadWriter(conn), record: r}
	if err := t.pairSetup(host, observe); err != nil {
		return nil, err
	}
	if !r.Valid() {
		return nil, ErrRemotePeerProof
	}
	return r, nil
}

// OpenRemoteUserspace accepts a previously matched LAN endpoint and verifies the saved peer before TLS/CDTunnel.
func OpenRemoteUserspace(lifetime, setup context.Context, control net.Conn, r *RemotePairRecord, dial func(context.Context, uint16) (net.Conn, error)) (*Userspace, error) {
	if !r.Valid() {
		control.Close()
		return nil, ErrRemotePairingRequired
	}
	stop := context.AfterFunc(setup, func() { _ = control.Close() })
	defer stop()
	defer control.Close()
	if d, ok := setup.Deadline(); ok {
		_ = control.SetDeadline(d)
	}
	t := &tunnelService{c: control, controlChannel: newControlChannelReadWriter(&remoteSocket{Conn: control}), record: r}
	if _, err := t.handshake(); err != nil {
		return nil, err
	}
	if err := t.verifyPair(); err != nil {
		return nil, err
	}
	port, err := t.createTcpTunnelListener()
	if err != nil {
		return nil, err
	}
	raw, err := dial(setup, port)
	if err != nil {
		return nil, err
	}
	abort := context.AfterFunc(setup, func() { _ = raw.Close() })
	if d, ok := setup.Deadline(); ok {
		_ = raw.SetDeadline(d)
	}
	tls, err := tlspsk.Client(raw, t.sharedSecret)
	if err != nil {
		abort()
		return nil, err
	}
	u, err := OpenUserspace(lifetime, tls)
	abort()
	if err != nil {
		tls.Close()
		return nil, err
	}
	if setup.Err() != nil {
		u.Close()
		u.Wait()
		return nil, setup.Err()
	}
	_ = raw.SetDeadline(time.Time{})
	return u, nil
}

type remoteSocket struct {
	net.Conn
	last uint64
	seen bool
}

func (s *remoteSocket) Send(message map[string]interface{}, _ ...uint32) error {
	b, err := json.Marshal(message["value"])
	if err != nil {
		return err
	}
	if len(b) == 0 || len(b) > 65535 {
		return ErrTunnel
	}
	header := append([]byte("RPPairing"), byte(len(b)>>8), byte(len(b)))
	return writePacket(s.Conn, append(header, b...))
}
func (s *remoteSocket) ReceiveOnClientServerStream() (map[string]interface{}, error) {
	var header [11]byte
	if _, err := io.ReadFull(s.Conn, header[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(header[9:]))
	if !bytes.Equal(header[:9], []byte("RPPairing")) || n == 0 {
		return nil, ErrTunnel
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(s.Conn, b); err != nil {
		return nil, err
	}
	var envelope struct {
		Message  map[string]interface{} `json:"message"`
		Origin   string                 `json:"originatedBy"`
		Sequence uint64                 `json:"sequenceNumber"`
	}
	if json.Unmarshal(b, &envelope) != nil || envelope.Origin != "device" || (s.seen && envelope.Sequence <= s.last) {
		return nil, ErrTunnel
	}
	s.seen = true
	s.last = envelope.Sequence
	m := envelope.Message
	if pairing, err := getChildMap(m, "plain", "_0", "event", "_0", "pairingData", "_0"); err == nil {
		str, ok := pairing["data"].(string)
		if !ok {
			return nil, ErrTunnel
		}
		data, err := base64.StdEncoding.DecodeString(str)
		if err != nil {
			return nil, ErrTunnel
		}
		pairing["data"] = data
	}
	if encrypted, err := getChildMap(m, "streamEncrypted"); err == nil {
		str, ok := encrypted["_0"].(string)
		if !ok {
			return nil, ErrTunnel
		}
		data, err := base64.StdEncoding.DecodeString(str)
		if err != nil {
			return nil, ErrTunnel
		}
		encrypted["_0"] = data
	}
	return map[string]interface{}{"value": map[string]interface{}{"message": m}}, nil
}
