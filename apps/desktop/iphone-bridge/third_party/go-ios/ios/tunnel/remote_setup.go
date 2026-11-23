package tunnel

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"github.com/danielpaulus/go-ios/ios/opack"
	"golang.org/x/crypto/chacha20poly1305"
)

// wireProtocolVersion is the RemotePairing control-channel version the host speaks.
const wireProtocolVersion = int64(19)

// PairHost is how this computer presents itself to the phone during Pair Setup.
// The phone keeps it with the pairing, so it should be the name a person recognises.
type PairHost struct {
	// Name is the computer's person-facing name; it is also sent as sendingHost.
	Name string
	// Model is the hardware model identifier, for example "Mac15,9".
	Model string
}

// PairStage is progress the person may need to act on while pairing.
type PairStage string

// PairStageAwaitingConsent means the phone is asking its owner to allow this computer.
const PairStageAwaitingConsent PairStage = "awaiting-consent"

var (
	// ErrRemotePairingDenied means the phone's owner declined the pairing on the phone.
	ErrRemotePairingDenied = errors.New("remote pairing was declined on the device")
	// ErrRemotePairingUnavailable means the phone is not accepting a new pairing now.
	ErrRemotePairingUnavailable = errors.New("the device is not accepting a new pairing")
	// ErrRemotePairingBusy means the phone is in another pairing or is backing off after failures.
	ErrRemotePairingBusy = errors.New("the device is busy with another pairing")
	// ErrRemotePairingProtocol means the phone answered outside the pairing protocol.
	ErrRemotePairingProtocol = errors.New("remote pairing protocol violation")
)

// HAP-style TLV error codes carried by RemotePairing.
const (
	tlvErrorAuthentication = 0x02
	tlvErrorBackoff        = 0x03
	tlvErrorMaxPeers       = 0x04
	tlvErrorMaxTries       = 0x05
	tlvErrorUnavailable    = 0x06
	tlvErrorBusy           = 0x07
)

// handshake opens the control channel and returns the device's handshake payload.
func (t *tunnelService) handshake() (map[string]interface{}, error) {
	err := t.controlChannel.writeRequest(map[string]interface{}{
		"handshake": map[string]interface{}{
			"_0": map[string]interface{}{
				"hostOptions":         map[string]interface{}{"attemptPairVerify": true},
				"wireProtocolVersion": wireProtocolVersion,
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("handshake: %w", err)
	}
	reply, err := t.controlChannel.read()
	if err != nil {
		return nil, err
	}
	handshake, err := getChildMap(reply, "plain", "_0", "response", "_1", "handshake", "_0")
	if err != nil {
		return nil, ErrTunnel
	}
	return handshake, nil
}

// pairSetup runs a complete Pair Setup and fills t.record with the phone's identity.
//
// The device's state machine requires a Pair Verify attempt before it accepts either
// pairVerifyFailed or Pair Setup: either one sent straight after the handshake makes
// it reset the control stream (HTTP/2 STREAM_CLOSED). A host without a record still
// opens Verify with a fresh key and then declines it.
func (t *tunnelService) pairSetup(host PairHost, observe func(PairStage)) error {
	if host.Name == "" {
		host.Name = "Mac"
	}
	handshake, err := t.handshake()
	if err != nil {
		return err
	}
	if options, err := getChildMap(handshake, "deviceOptions"); err == nil {
		if allowed, ok := options["allowsPairSetup"].(bool); ok && !allowed {
			return ErrRemotePairingUnavailable
		}
	}
	if err := t.declineVerify(observe); err != nil {
		return fmt.Errorf("pairSetup: verify: %w", err)
	}

	start := newTlvBuffer()
	start.writeByte(typeMethod, 0x00)
	start.writeByte(typeState, pairStateStartRequest)
	if err := t.controlChannel.writeEvent(&pairingData{data: start.bytes(), kind: "setupManualPairing", sendingHost: host.Name, startNewSession: true}); err != nil {
		return fmt.Errorf("pairSetup: M1: %w", err)
	}
	m2, err := t.readPairingData(observe, pairStateStartResponse)
	if err != nil {
		return fmt.Errorf("pairSetup: M2: %w", err)
	}
	salt, err := tlvReader(m2.data).readCoalesced(typeSalt)
	if err != nil || len(salt) == 0 {
		return ErrRemotePairingProtocol
	}
	devicePublic, err := tlvReader(m2.data).readCoalesced(typePublicKey)
	if err != nil || len(devicePublic) == 0 {
		return ErrRemotePairingProtocol
	}

	srp, err := newSrpInfo(salt, devicePublic)
	if err != nil {
		return fmt.Errorf("pairSetup: SRP: %w", err)
	}
	proof := newTlvBuffer()
	proof.writeByte(typeState, pairStateVerifyRequest)
	proof.writeData(typePublicKey, srp.ClientPublic)
	proof.writeData(typeProof, srp.ClientProof)
	if err := t.controlChannel.writeEvent(&pairingData{data: proof.bytes(), kind: "setupManualPairing", sendingHost: host.Name}); err != nil {
		return fmt.Errorf("pairSetup: M3: %w", err)
	}
	m4, err := t.readPairingData(observe, pairStateVerifyResponse)
	if err != nil {
		return fmt.Errorf("pairSetup: M4: %w", err)
	}
	serverProof, err := tlvReader(m4.data).readCoalesced(typeProof)
	if err != nil || !srp.verifyServerProof(serverProof) {
		return ErrRemotePeerProof
	}
	return t.exchangeIdentity(srp.SessionKey, host, observe)
}

// declineVerify opens Pair Verify with a fresh ephemeral key and declines it, which is
// the only order in which the device then accepts Pair Setup.
func (t *tunnelService) declineVerify(observe func(PairStage)) error {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	tlv := newTlvBuffer()
	tlv.writeByte(typeState, pairStateStartRequest)
	tlv.writeData(typePublicKey, key.PublicKey().Bytes())
	if err := t.controlChannel.writeEvent(&pairingData{data: tlv.bytes(), kind: "verifyManualPairing", startNewSession: true}); err != nil {
		return err
	}
	// Any answer, an M2 we cannot finish or a refusal, leaves Verify for us to end.
	if _, err := t.readPairingEvent(observe); err != nil {
		return err
	}
	return t.controlChannel.writeEvent(pairVerifyFailed{})
}

// exchangeIdentity sends this host's long-term identity (M5) and accepts the phone's (M6).
func (t *tunnelService) exchangeIdentity(sessionKey []byte, host PairHost, observe func(PairStage)) error {
	signed := append(deriveRemote(sessionKey, "Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info"), t.record.HostIdentifier...)
	signed = append(signed, t.record.publicKey()...)
	signature := ed25519.Sign(t.record.privateKey(), signed)

	model := host.Model
	if model == "" {
		model = "Mac"
	}
	// accountID and altIRK are what the device uses later; the radio addresses and serial
	// identify nothing and are deliberately not the computer's real ones.
	info, err := opack.Encode(map[string]interface{}{
		"accountID":                   t.record.HostIdentifier,
		"altIRK":                      t.record.HostIRK,
		"btAddr":                      "FF:DD:99:66:BB:AA",
		"mac":                         []byte{0xff, 0x44, 0x88, 0x66, 0x33, 0x99},
		"model":                       model,
		"name":                        host.Name,
		"remotepairing_serial_number": "remote-serial",
	})
	if err != nil {
		return err
	}
	plain := newTlvBuffer()
	plain.writeData(typeSignature, signature)
	plain.writeData(typePublicKey, t.record.publicKey())
	plain.writeData(typeIdentifier, []byte(t.record.HostIdentifier))
	plain.writeData(typeInfo, info)

	aead, err := chacha20poly1305.New(deriveRemote(sessionKey, "Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info"))
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize())
	copy(nonce[4:], "PS-Msg05")
	m5 := newTlvBuffer()
	m5.writeByte(typeState, pairStateExchangeRequest)
	m5.writeData(typeEncryptedData, aead.Seal(nil, nonce, plain.bytes(), nil))
	if err := t.controlChannel.writeEvent(&pairingData{data: m5.bytes(), kind: "setupManualPairing", sendingHost: host.Name}); err != nil {
		return fmt.Errorf("pairSetup: M5: %w", err)
	}
	m6, err := t.readPairingData(observe, pairStateExchangeResponse)
	if err != nil {
		return fmt.Errorf("pairSetup: M6: %w", err)
	}
	encrypted, err := tlvReader(m6.data).readCoalesced(typeEncryptedData)
	if err != nil || len(encrypted) == 0 {
		return ErrRemotePairingProtocol
	}
	copy(nonce[4:], "PS-Msg06")
	peer, err := aead.Open(nil, nonce, encrypted, nil)
	if err != nil {
		return ErrRemotePeerProof
	}
	return t.record.acceptPeer(sessionKey, peer)
}

// readPairingData reads the next pairing message and checks its state and TLV error.
func (t *tunnelService) readPairingData(observe func(PairStage), state byte) (pairingData, error) {
	data, err := t.readPairingEvent(observe)
	if err != nil {
		return pairingData{}, err
	}
	if err := pairingTLVError(data.data); err != nil {
		return pairingData{}, err
	}
	got, err := tlvReader(data.data).readCoalesced(typeState)
	if err != nil || !bytes.Equal(got, []byte{state}) {
		return pairingData{}, ErrRemotePairingProtocol
	}
	return data, nil
}

// readPairingEvent returns the next pairingData event, reporting consent prompts on the way.
func (t *tunnelService) readPairingEvent(observe func(PairStage)) (pairingData, error) {
	// Consent is reported once per prompt; a phone that repeats it is still bounded.
	for range 16 {
		message, err := t.controlChannel.read()
		if err != nil {
			return pairingData{}, err
		}
		event, err := getChildMap(message, "plain", "_0", "event", "_0")
		if err != nil {
			return pairingData{}, ErrRemotePairingProtocol
		}
		if _, ok := event["pairingData"]; ok {
			var data pairingData
			if err := data.Decode(event); err != nil {
				return pairingData{}, ErrRemotePairingProtocol
			}
			return data, nil
		}
		if _, ok := event["awaitingUserConsent"]; ok {
			if observe != nil {
				observe(PairStageAwaitingConsent)
			}
			continue
		}
		for name, value := range event {
			if strings.Contains(strings.ToLower(name), "reject") {
				return pairingData{}, fmt.Errorf("%w: %s", ErrRemotePairingDenied, rejectionReason(value))
			}
		}
		return pairingData{}, ErrRemotePairingProtocol
	}
	return pairingData{}, ErrRemotePairingProtocol
}

func pairingTLVError(data []byte) error {
	code, err := tlvReader(data).readCoalesced(typeError)
	if err != nil {
		return ErrRemotePairingProtocol
	}
	if len(code) == 0 {
		return nil
	}
	switch code[0] {
	case tlvErrorAuthentication:
		return ErrRemotePeerProof
	case tlvErrorBackoff, tlvErrorBusy, tlvErrorMaxTries:
		return ErrRemotePairingBusy
	case tlvErrorMaxPeers, tlvErrorUnavailable:
		return ErrRemotePairingUnavailable
	}
	return fmt.Errorf("%w: TLV error %d", ErrRemotePairingProtocol, code[0])
}

// rejectionReason extracts the phone's localized description without trusting its shape.
func rejectionReason(value interface{}) string {
	var walk func(interface{}, int) string
	walk = func(v interface{}, depth int) string {
		if depth > 6 {
			return ""
		}
		m, ok := v.(map[string]interface{})
		if !ok {
			return ""
		}
		if s, ok := m["NSLocalizedDescription"].(string); ok && len(s) <= 512 {
			return s
		}
		for _, child := range m {
			if s := walk(child, depth+1); s != "" {
				return s
			}
		}
		return ""
	}
	if s := walk(value, 0); s != "" {
		return s
	}
	return "declined"
}
