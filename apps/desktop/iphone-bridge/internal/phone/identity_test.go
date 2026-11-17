package phone

import (
	"context"
	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"os"
	"testing"
)

func TestPrivateIdentityOnlyResolvesLiveCandidate(t *testing.T) {
	m := NewManager(context.Background(), nil, nil)
	defer m.Close()
	m.phones["candidate"] = &localPhone{identity: "synthetic-private-phone", entry: ios.DeviceEntry{DeviceID: 1}}
	value, err := m.privateIdentity("candidate")
	if err != nil || value.(wire.IdentityResult).UDID != "synthetic-private-phone" {
		t.Fatal("live identity unavailable")
	}
	m.phones["candidate"].entry = ios.DeviceEntry{}
	if _, err := m.privateIdentity("candidate"); err == nil {
		t.Fatal("removed candidate resolved")
	}
	if _, err := m.privateIdentity("other"); err == nil {
		t.Fatal("unknown candidate resolved")
	}
	if _, err := wire.Params(wire.Request{Method: "phone.identity", Params: []byte(`{"candidateId":"candidate","udid":"forged"}`)}); err == nil {
		t.Fatal("extra identity input admitted")
	}
}

func TestForgetPrivateBindingAfterRestartWithoutPhone(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := Owner{"deployment-a", "host-a", "runner-a", "device-a", 1}
	reservation, err := Reserve(root, "synthetic-private-phone", owner)
	if err != nil {
		t.Fatal(err)
	}
	reservation.Close()
	manager := NewManager(context.Background(), nil, nil)
	manager.root = root
	defer manager.Close()
	p := &wire.ForgetBindingParams{UDID: "synthetic-private-phone", DeploymentID: "deployment-b", HostInstanceID: "host-a", RunnerID: "runner-a", DeviceID: "device-a", DriverGeneration: 1}
	if err := manager.forgetPrivateBinding(p); err == nil {
		t.Fatal("another Deployment cleared durable ownership")
	}
	p.DeploymentID = owner.DeploymentID
	if err := manager.forgetPrivateBinding(p); err != nil {
		t.Fatal(err)
	}
	owner.DeploymentID = "deployment-b"
	next, err := Reserve(root, p.UDID, owner)
	if err != nil {
		t.Fatal("explicit offline detach failed to release ownership")
	}
	next.Close()
}

func TestForgetPrivateBindingReclaimsOnlyExactOwnedBinding(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := Owner{"deployment-a", "host-a", "runner-a", "setup-a", 1}
	reservation, err := Reserve(root, "synthetic-private-phone", owner)
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(context.Background(), nil, nil)
	manager.root = root
	defer manager.Close()
	manager.phones["candidate"] = &localPhone{identity: "synthetic-private-phone", id: "candidate", binding: "lost-reply-token", epoch: 1, reservation: reservation}
	p := &wire.ForgetBindingParams{UDID: "synthetic-private-phone", DeploymentID: "deployment-a", HostInstanceID: "host-a", RunnerID: "runner-a", DeviceID: "another-setup", DriverGeneration: 1}
	if err := manager.forgetPrivateBinding(p); err == nil {
		t.Fatal("different setup reclaimed an active binding")
	}
	p.DeviceID = owner.DeviceID
	if err := manager.forgetPrivateBinding(p); err != nil {
		t.Fatal(err)
	}
	if manager.phones["candidate"].binding != "" {
		t.Fatal("lost-reply binding remained active")
	}
	owner.DeploymentID = "deployment-b"
	next, err := Reserve(root, p.UDID, owner)
	if err != nil {
		t.Fatal("owned binding was not released")
	}
	next.Close()
}

func TestRosterTrustUsesPairingRatherThanMetadata(t *testing.T) {
	m := NewManager(context.Background(), nil, nil)
	defer m.Close()
	m.phones["candidate"] = &localPhone{id: "candidate", entry: ios.DeviceEntry{DeviceID: 1}, inspection: Inspection{Pairing: "unknown", Model: "iPhoneFixture"}}
	if m.roster().Candidates[0].Trust == "trusted" {
		t.Fatal("unpaired phone was trusted because it had metadata")
	}
	m.phones["candidate"].inspection = Inspection{Pairing: "paired"}
	if m.roster().Candidates[0].Trust != "trusted" {
		t.Fatal("paired phone needed metadata to be trusted")
	}
}
