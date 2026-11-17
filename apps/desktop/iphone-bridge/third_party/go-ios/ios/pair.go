package ios

import (
	"bytes"
	"errors"
	"strings"
	"sync"

	"github.com/google/uuid"
	plist "howett.net/plist"
)

// PairingAttempt retains the private identity while the same Trust request is pending.
// The caller owns its lifetime; it must never be logged or persisted outside usbmux.
type PairingAttempt struct {
	mu     sync.Mutex
	record *pendingPairRecord
}
type pendingPairRecord struct {
	publicKey      []byte
	buid           string
	wifiMac        string
	data           FullPairRecordData
	rootPrivateKey []byte
	hostPrivateKey []byte
}

func Pair(device DeviceEntry) error { return (&PairingAttempt{}).Pair(device) }
func (attempt *PairingAttempt) Pair(device DeviceEntry) error {
	attempt.mu.Lock()
	defer attempt.mu.Unlock()

	usbmuxConn, err := NewUsbMuxConnectionContext(device.ContextOrBackground())
	if err != nil {
		return err
	}
	defer usbmuxConn.Close()
	buid, err := usbmuxConn.ReadBuid()
	if err != nil {
		return err
	}
	lockdown, err := usbmuxConn.ConnectLockdown(device.DeviceID)
	if err != nil {
		return err
	}
	publicKey, err := lockdown.GetValue("DevicePublicKey")
	if err != nil {
		return err
	}
	wifiMac, err := lockdown.GetValue("WiFiAddress")
	if err != nil {
		return err
	}
	publicKeyBytes, ok := publicKey.([]byte)
	if !ok {
		return errors.New("invalid device public key response")
	}
	wifiMacString, ok := wifiMac.(string)
	if !ok {
		return errors.New("invalid device Wi-Fi address response")
	}

	pending, err := attempt.identity(publicKeyBytes, buid, wifiMacString)
	if err != nil {
		return err
	}
	pairRecordData := pending.data
	request := newLockDownPairRequest(pairRecordData)

	err = lockdown.Send(request)
	if err != nil {
		return err
	}
	resp, err := lockdown.ReadMessage()
	if err != nil {
		return err
	}
	response := getLockdownPairResponsefromBytes(resp)
	if isPairingDialogOpen(response) {
		return &LockdownError{Code: response.Error}
	}
	if response.Error != "" {
		return &LockdownError{Code: response.Error}
	}
	if response.Request != "Pair" || len(response.EscrowBag) == 0 {
		return &LockdownError{Code: "InvalidPairResponse"}
	}
	usbmuxConn, err = NewUsbMuxConnectionContext(device.ContextOrBackground())
	if err != nil {
		return err
	}
	defer usbmuxConn.Close()
	success, err := usbmuxConn.savePair(device.Properties.SerialNumber, pairRecordData.DeviceCertificate, pending.hostPrivateKey, pairRecordData.HostCertificate, pending.rootPrivateKey, pairRecordData.RootCertificate, response.EscrowBag, pending.wifiMac, pairRecordData.HostID, buid)
	if !success || err != nil {
		return errors.New("Saving the PairRecord to usbmux failed")
	}
	attempt.record = nil
	return nil
}

func (attempt *PairingAttempt) identity(publicKey []byte, buid, wifiMac string) (*pendingPairRecord, error) {
	if attempt.record != nil {
		if !bytes.Equal(attempt.record.publicKey, publicKey) || attempt.record.buid != buid || attempt.record.wifiMac != wifiMac {
			return nil, errors.New("pairing device identity changed")
		}
		return attempt.record, nil
	}
	rootCert, hostCert, deviceCert, rootKey, hostKey, err := createRootCertificate(publicKey)
	if err != nil {
		return nil, errors.New("could not create pairing identity")
	}
	attempt.record = &pendingPairRecord{publicKey: bytes.Clone(publicKey), buid: buid, wifiMac: wifiMac, data: newFullPairRecordData(buid, hostCert, rootCert, deviceCert), rootPrivateKey: rootKey, hostPrivateKey: hostKey}
	return attempt.record, nil
}

type FullPairRecordData struct {
	DeviceCertificate []byte
	HostCertificate   []byte
	RootCertificate   []byte
	SystemBUID        string
	HostID            string
}

type PairingOptions struct {
	ExtendedPairingErrors bool
}

type LockDownPairRequest struct {
	Label           string
	PairRecord      FullPairRecordData
	Request         string
	ProtocolVersion string
	PairingOptions  PairingOptions
}

type LockdownPairResponse struct {
	Error     string
	Request   string
	EscrowBag []byte
}

func getLockdownPairResponsefromBytes(plistBytes []byte) LockdownPairResponse {
	decoder := plist.NewDecoder(bytes.NewReader(plistBytes))
	var data LockdownPairResponse
	_ = decoder.Decode(&data)
	return data
}

func isPairingDialogOpen(resp LockdownPairResponse) bool {
	return resp.Error == "PairingDialogResponsePending"
}

func newLockDownPairRequest(pairRecord FullPairRecordData) LockDownPairRequest {
	var req LockDownPairRequest
	req.Label = "go-ios"
	req.PairingOptions = PairingOptions{true}
	req.Request = "Pair"
	req.ProtocolVersion = "2"
	req.PairRecord = pairRecord
	return req
}

func newFullPairRecordData(systemBuid string, hostCert []byte, rootCert []byte, deviceCert []byte) FullPairRecordData {
	var data FullPairRecordData
	data.SystemBUID = systemBuid
	data.HostID = strings.ToUpper(uuid.New().String())
	data.RootCertificate = rootCert
	data.HostCertificate = hostCert
	data.DeviceCertificate = deviceCert

	return data
}
