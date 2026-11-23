package tunnel

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha512"
	"fmt"

	"io"

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
