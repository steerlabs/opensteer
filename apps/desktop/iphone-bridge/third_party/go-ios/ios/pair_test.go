package ios

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

func TestPairingAttemptKeepsIdentityAndRejectsDeviceChanges(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	public := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&key.PublicKey)})
	attempt := &PairingAttempt{}
	first, err := attempt.identity(public, "synthetic-buid", "synthetic-wifi")
	if err != nil {
		t.Fatal(err)
	}
	second, err := attempt.identity(public, "synthetic-buid", "synthetic-wifi")
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.data.HostID != second.data.HostID {
		t.Fatal("Trust retry created another pairing identity")
	}
	if _, err := attempt.identity([]byte("other-device"), "synthetic-buid", "synthetic-wifi"); err == nil {
		t.Fatal("pending identity was reused for another device")
	}
	other, err := (&PairingAttempt{}).identity(public, "synthetic-buid", "synthetic-wifi")
	if err != nil {
		t.Fatal(err)
	}
	if other.data.HostID == first.data.HostID {
		t.Fatal("new attempt reused private identity")
	}
}
