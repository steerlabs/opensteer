package tunnel

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha512"
	"fmt"

	"io"

	"github.com/danielpaulus/go-ios/ios/opack"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/ed25519"
	"golang.org/x/crypto/hkdf"
)

// untrustedTunnelServiceName is the service name that is described in the Remote Service Discovery of the
// ethernet interface of the device (not the tunnel interface)
const untrustedTunnelServiceName = "com.apple.internal.dt.coredevice.untrusted.tunnelservice"

type tunnelService struct {
	c              io.Closer
	controlChannel *controlChannelReadWriter
	cipher         *cipherStream
	record         *RemotePairRecord
	sharedSecret   []byte
}

func (t *tunnelService) Close() error {
	return t.c.Close()
}

func (t *tunnelService) ManualPair() error {
	err := t.controlChannel.writeRequest(map[string]interface{}{
		"handshake": map[string]interface{}{
			"_0": map[string]interface{}{
				"hostOptions": map[string]interface{}{
					"attemptPairVerify": true,
				},
				"wireProtocolVersion": int64(19),
			},
		},
	})

	if err != nil {
		return fmt.Errorf("ManualPair: failed to send 'attemptPairVerify' request: %w", err)
	}
	reply, err := t.controlChannel.read()
	if err != nil {
		return err
	}
	if _, err := getChildMap(reply, "plain", "_0", "response", "_1", "handshake", "_0"); err != nil {
		return ErrTunnel
	}
	if err := t.controlChannel.writeEvent(pairVerifyFailed{}); err != nil {
		return err
	}

	err = t.setupManualPairing()
	if err != nil {
		return fmt.Errorf("ManualPair: failed to initiate manual pairing: %w", err)
	}

	sessionKey, err := t.setupSessionKey()
	if err != nil {
		return fmt.Errorf("ManualPair: failed to setup SRP session key: %w", err)
	}

	err = t.exchangeDeviceInfo(sessionKey)
	if err != nil {
		return fmt.Errorf("ManualPair: failed to exchange device info: %w", err)
	}

	return nil
}

// createTcpTunnelListener asks the device to open a TCP tunnel listener (the
// transport used since iOS 18.2, which removed QUIC). Unlike the QUIC listener,
// the device authenticates the TLS connection with a pre-shared key: we send the
// raw pair-verify shared secret as the createListener key, and the device
// replies with just a port to dial. The same secret is used as the TLS PSK.
func (t *tunnelService) createTcpTunnelListener() (uint16, error) {
	if len(t.sharedSecret) == 0 {
		return 0, fmt.Errorf("createTcpTunnelListener: no pair-verify shared secret available (TLS-PSK tunnel requires a verified pairing)")
	}

	err := t.cipher.write(map[string]interface{}{
		"request": map[string]interface{}{
			"_0": map[string]interface{}{
				"createListener": map[string]interface{}{
					"key":                   t.sharedSecret,
					"transportProtocolType": "tcp",
				},
			},
		},
	})
	if err != nil {
		return 0, err
	}

	var listenerRes map[string]interface{}
	err = t.cipher.read(&listenerRes)
	if err != nil {
		return 0, err
	}

	createListener, err := getChildMap(listenerRes, "response", "_1", "createListener")
	if err != nil {
		return 0, err
	}
	port, ok := createListener["port"].(float64)
	if !ok {
		return 0, fmt.Errorf("createTcpTunnelListener: no port in createListener response")
	}
	if port < 1 || port > 65535 || port != float64(uint16(port)) {
		return 0, ErrTunnel
	}
	return uint16(port), nil
}

func (t *tunnelService) setupCiphers(sessionKey []byte) error {
	clientKey := make([]byte, 32)
	_, err := hkdf.New(sha512.New, sessionKey, nil, []byte("ClientEncrypt-main")).Read(clientKey)
	if err != nil {
		return err
	}
	serverKey := make([]byte, 32)
	_, err = hkdf.New(sha512.New, sessionKey, nil, []byte("ServerEncrypt-main")).Read(serverKey)
	if err != nil {
		return err
	}
	server, err := chacha20poly1305.New(serverKey)
	if err != nil {
		return err
	}
	client, err := chacha20poly1305.New(clientKey)
	if err != nil {
		return err
	}

	t.cipher = newCipherStream(t.controlChannel, client, server)

	return nil
}

func (t *tunnelService) setupManualPairing() error {
	buf := newTlvBuffer()
	buf.writeByte(typeMethod, 0x00)
	buf.writeByte(typeState, pairStateStartRequest)

	event := pairingData{
		data:            buf.bytes(),
		kind:            "setupManualPairing",
		startNewSession: true,
	}

	err := t.controlChannel.writeEvent(&event)
	if err != nil {
		return err
	}
	_, err = t.controlChannel.read()
	if err != nil {
		return err
	}
	return err
}

func (t *tunnelService) readDeviceKey() (publicKey []byte, salt []byte, err error) {
	var pairingData pairingData
	err = t.controlChannel.readEvent(&pairingData)
	if err != nil {
		return
	}
	publicKey, err = tlvReader(pairingData.data).readCoalesced(typePublicKey)
	if err != nil {
		return
	}
	salt, err = tlvReader(pairingData.data).readCoalesced(typeSalt)
	if err != nil {
		return
	}
	return
}

func (t *tunnelService) verifyPair() error {
	if !t.record.Valid() {
		return ErrRemotePairingRequired
	}
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	tlv := newTlvBuffer()
	tlv.writeByte(typeState, pairStateStartRequest)
	tlv.writeData(typePublicKey, key.PublicKey().Bytes())

	event := pairingData{
		data:            tlv.bytes(),
		kind:            "verifyManualPairing",
		startNewSession: true,
	}

	selfId := t.record

	if err := t.controlChannel.writeEvent(&event); err != nil {
		return err
	}

	var devP pairingData
	err := t.controlChannel.readEvent(&devP)
	if err != nil {
		return err
	}

	refusal, err := tlvReader(devP.data).readCoalesced(typeError)
	if err != nil {
		return ErrRemotePeerProof
	}
	if len(refusal) > 0 {
		return ErrRemotePairingRequired
	}
	state, err := tlvReader(devP.data).readCoalesced(typeState)
	if err != nil || !bytes.Equal(state, []byte{pairStateStartResponse}) {
		return ErrRemotePeerProof
	}
	devicePublicKeyBytes, err := tlvReader(devP.data).readCoalesced(typePublicKey)
	if err != nil {
		return err
	}

	if devicePublicKeyBytes == nil {
		_ = t.controlChannel.writeEvent(pairVerifyFailed{})
		return fmt.Errorf("verifyPair: did not get public key from device. Can not verify pairing")
	}
	devicePublicKey, err := ecdh.X25519().NewPublicKey(devicePublicKeyBytes)
	if err != nil {
		return err
	}

	sharedSecret, err := key.ECDH(devicePublicKey)
	if err != nil {
		return err
	}
	// Retain the raw shared secret; the TLS-PSK TCP tunnel (iOS 18.2+) uses it
	// directly as the pre-shared key.
	t.sharedSecret = sharedSecret

	derived := make([]byte, 32)
	_, err = hkdf.New(sha512.New, sharedSecret, []byte("Pair-Verify-Encrypt-Salt"), []byte("Pair-Verify-Encrypt-Info")).Read(derived)
	if err != nil {
		return err
	}

	ci, err := chacha20poly1305.New(derived)
	if err != nil {
		return err
	}

	signBuf := bytes.NewBuffer(nil)
	// Write on bytes.Buffer never returns an error
	_, _ = signBuf.Write(key.PublicKey().Bytes())
	_, _ = signBuf.Write([]byte(selfId.HostIdentifier))
	_, _ = signBuf.Write(devicePublicKeyBytes)

	encryptedProof, err := tlvReader(devP.data).readCoalesced(typeEncryptedData)
	if err != nil {
		return ErrRemotePeerProof
	}
	if err := verifyRemotePeer(ci, encryptedProof, devicePublicKeyBytes, key.PublicKey().Bytes(), t.record); err != nil {
		return err
	}
	signature := ed25519.Sign(selfId.privateKey(), signBuf.Bytes())

	cTlv := newTlvBuffer()
	cTlv.writeData(typeSignature, signature)
	cTlv.writeData(typeIdentifier, []byte(selfId.HostIdentifier))

	nonce := make([]byte, 12)
	copy(nonce[4:], "PV-Msg03")
	encrypted := ci.Seal(nil, nonce, cTlv.bytes(), nil)

	tlvOut := newTlvBuffer()
	tlvOut.writeByte(typeState, pairStateVerifyRequest)
	tlvOut.writeData(typeEncryptedData, encrypted)

	pd := pairingData{
		data:            tlvOut.bytes(),
		kind:            "verifyManualPairing",
		startNewSession: false,
	}

	err = t.controlChannel.writeEvent(&pd)
	if err != nil {
		return err
	}

	var responseEvent pairingData
	err = t.controlChannel.readEvent(&responseEvent)
	if err != nil {
		return err
	}

	state, err = tlvReader(responseEvent.data).readCoalesced(typeState)
	if err != nil || !bytes.Equal(state, []byte{pairStateVerifyResponse}) {
		return ErrRemotePeerProof
	}
	errRes, err := tlvReader(responseEvent.data).readCoalesced(typeError)
	if err != nil {
		return err
	}
	if len(errRes) > 0 {
		return ErrRemotePairingRequired
	}

	err = t.setupCiphers(sharedSecret)
	if err != nil {
		return err
	}

	return nil
}

func (t *tunnelService) setupSessionKey() ([]byte, error) {
	devicePublicKey, deviceSalt, err := t.readDeviceKey()
	if err != nil {
		return nil, fmt.Errorf("setupSessionKey: failed to read device public key and salt value: %w", err)
	}

	srp, err := newSrpInfo(deviceSalt, devicePublicKey)
	if err != nil {
		return nil, fmt.Errorf("setupSessionKey: failed to setup SRP: %w", err)
	}

	proofTlv := newTlvBuffer()
	proofTlv.writeByte(typeState, pairStateVerifyRequest)
	proofTlv.writeData(typePublicKey, srp.ClientPublic)
	proofTlv.writeData(typeProof, srp.ClientProof)

	err = t.controlChannel.writeEvent(&pairingData{
		data: proofTlv.bytes(),
		kind: "setupManualPairing",
	})
	if err != nil {
		return nil, fmt.Errorf("setupSessionKey: failed to send SRP proof: %w", err)
	}

	var proofPairingData pairingData
	err = t.controlChannel.readEvent(&proofPairingData)
	if err != nil {
		return nil, fmt.Errorf("setupSessionKey: failed to read device SRP proof: %w", err)
	}

	serverProof, err := tlvReader(proofPairingData.data).readCoalesced(typeProof)
	if err != nil {
		return nil, fmt.Errorf("setupSessionKey: failed to parse device proof: %w", err)
	}
	verified := srp.verifyServerProof(serverProof)
	if !verified {
		return nil, fmt.Errorf("setupSessionKey: could not verify server proof")
	}
	return srp.SessionKey, nil
}

func (t *tunnelService) exchangeDeviceInfo(sessionKey []byte) error {
	hkdfPairSetup := hkdf.New(sha512.New, sessionKey, []byte("Pair-Setup-Controller-Sign-Salt"), []byte("Pair-Setup-Controller-Sign-Info"))
	buf := bytes.NewBuffer(nil)
	// Write on bytes.Buffer never returns an error
	_, _ = io.CopyN(buf, hkdfPairSetup, 32)
	_, _ = buf.WriteString(t.record.HostIdentifier)
	_, _ = buf.Write(t.record.publicKey())

	signature := ed25519.Sign(t.record.privateKey(), buf.Bytes())

	// this represents the device info of this host that is stored on the device on a successful pairing.
	// The only relevant field is 'accountID' as it's used earlier in the pairing process already.
	// Everything else can be random data and is not needed later in any communication.
	deviceInfo, err := opack.Encode(map[string]interface{}{
		"accountID":                   t.record.HostIdentifier,
		"altIRK":                      t.record.HostIRK,
		"btAddr":                      "FF:DD:99:66:BB:AA",
		"mac":                         []byte{0xff, 0x44, 0x88, 0x66, 0x33, 0x99},
		"model":                       "go-ios",
		"name":                        "host-name",
		"remotepairing_serial_number": "remote-serial",
	})

	deviceInfoTlv := newTlvBuffer()
	deviceInfoTlv.writeData(typeSignature, signature)
	deviceInfoTlv.writeData(typePublicKey, t.record.publicKey())
	deviceInfoTlv.writeData(typeIdentifier, []byte(t.record.HostIdentifier))
	deviceInfoTlv.writeData(typeInfo, deviceInfo)

	sessionKeyBuf := bytes.NewBuffer(nil)
	_, err = io.CopyN(sessionKeyBuf, hkdf.New(sha512.New, sessionKey, []byte("Pair-Setup-Encrypt-Salt"), []byte("Pair-Setup-Encrypt-Info")), 32)
	if err != nil {
		return err
	}
	setupKey := sessionKeyBuf.Bytes()

	cipher, err := chacha20poly1305.New(setupKey)
	if err != nil {
		return err
	}

	nonce := make([]byte, cipher.NonceSize())
	copy(nonce[4:], "PS-Msg05")
	x := cipher.Seal(nil, nonce, deviceInfoTlv.bytes(), nil)

	encryptedTlv := newTlvBuffer()
	encryptedTlv.writeByte(typeState, 0x05)
	encryptedTlv.writeData(typeEncryptedData, x)

	err = t.controlChannel.writeEvent(&pairingData{
		data:        encryptedTlv.bytes(),
		kind:        "setupManualPairing",
		sendingHost: "SL-1876",
	})
	if err != nil {
		return err
	}

	var encRes pairingData
	err = t.controlChannel.readEvent(&encRes)
	if err != nil {
		return err
	}

	encrData, err := tlvReader(encRes.data).readCoalesced(typeEncryptedData)
	if err != nil {
		return err
	}
	copy(nonce[4:], "PS-Msg06")
	plain, err := cipher.Open(nil, nonce, encrData, nil)
	if err != nil {
		return ErrRemotePeerProof
	}
	return t.record.acceptPeer(sessionKey, plain)
}
