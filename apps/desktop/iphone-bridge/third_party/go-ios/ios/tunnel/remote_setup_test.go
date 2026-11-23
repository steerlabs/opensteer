package tunnel

import (
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

// strictPhone models the iOS 27 RemotePairing control channel's ordering rule: an event
// that ends or skips Pair Verify before the host has opened it resets the stream, as a
// real iPhone does with HTTP/2 STREAM_CLOSED.
type strictPhone struct {
	mode         string
	setupAllowed bool
	verified     bool
	reset        bool
	seen         []string
	setupHosts   []string
	queue        []map[string]interface{}
}

var errStreamClosed = errors.New("stream 1 was reset by the peer (STREAM_CLOSED)")

func envelope(message map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"value": map[string]interface{}{"message": map[string]interface{}{"plain": map[string]interface{}{"_0": message}}}}
}
func phoneEvent(event map[string]interface{}) map[string]interface{} {
	return envelope(map[string]interface{}{"event": map[string]interface{}{"_0": event}})
}
func phonePairing(kind string, tlv tlvBuffer) map[string]interface{} {
	return phoneEvent((&pairingData{data: tlv.bytes(), kind: kind}).Encode())
}

func (p *strictPhone) Send(m map[string]interface{}, _ ...uint32) error {
	message, err := getChildMap(m, "value", "message", "plain", "_0")
	if err != nil {
		return err
	}
	if _, err := getChildMap(message, "request", "_0", "handshake"); err == nil {
		p.seen = append(p.seen, "handshake")
		p.queue = append(p.queue, envelope(map[string]interface{}{"response": map[string]interface{}{"_1": map[string]interface{}{"handshake": map[string]interface{}{"_0": map[string]interface{}{
			"deviceOptions": map[string]interface{}{"allowsPairSetup": p.setupAllowed},
		}}}}}))
		return nil
	}
	event, err := getChildMap(message, "event", "_0")
	if err != nil {
		return err
	}
	if _, ok := event["pairVerifyFailed"]; ok {
		p.seen = append(p.seen, "pairVerifyFailed")
		if !p.verified {
			p.reset = true
		}
		return nil
	}
	var data pairingData
	if err := data.Decode(event); err != nil {
		return err
	}
	state, _ := tlvReader(data.data).readCoalesced(typeState)
	step := data.kind + ":" + string(rune('0'+state[0]))
	p.seen = append(p.seen, step)
	switch step {
	case "verifyManualPairing:1":
		p.verified = true
		m2 := newTlvBuffer()
		m2.writeByte(typeState, pairStateStartResponse)
		m2.writeData(typePublicKey, make([]byte, 32))
		p.queue = append(p.queue, phonePairing("verifyManualPairing", m2))
	case "setupManualPairing:1":
		if !p.verified {
			p.reset = true
			return nil
		}
		p.setupHosts = append(p.setupHosts, data.sendingHost)
		p.queue = append(p.queue, phoneEvent(map[string]interface{}{"awaitingUserConsent": map[string]interface{}{}}))
		switch p.mode {
		case "denied":
			p.queue = append(p.queue, phoneEvent(map[string]interface{}{"pairingRejectedWithError": map[string]interface{}{
				"wrappedError": map[string]interface{}{"userInfo": map[string]interface{}{"NSLocalizedDescription": "The person declined"}},
			}}))
		case "unavailable":
			refusal := newTlvBuffer()
			refusal.writeByte(typeState, pairStateStartResponse)
			refusal.writeByte(typeError, tlvErrorUnavailable)
			p.queue = append(p.queue, phonePairing("setupManualPairing", refusal))
		case "srp":
			public := make([]byte, 384)
			_, _ = rand.Read(public)
			public[0] = 0x01
			m2 := newTlvBuffer()
			m2.writeByte(typeState, pairStateStartResponse)
			m2.writeData(typeSalt, make([]byte, 16))
			m2.writeData(typePublicKey, public)
			p.queue = append(p.queue, phonePairing("setupManualPairing", m2))
		}
	case "setupManualPairing:3":
		p.setupHosts = append(p.setupHosts, data.sendingHost)
		refusal := newTlvBuffer()
		refusal.writeByte(typeState, pairStateVerifyResponse)
		refusal.writeByte(typeError, tlvErrorAuthentication)
		p.queue = append(p.queue, phonePairing("setupManualPairing", refusal))
	}
	return nil
}

func (p *strictPhone) ReceiveOnClientServerStream() (map[string]interface{}, error) {
	if p.reset {
		return nil, errStreamClosed
	}
	if len(p.queue) == 0 {
		return nil, errors.New("phone has nothing to say")
	}
	next := p.queue[0]
	p.queue = p.queue[1:]
	return next, nil
}

func runPairSetup(t *testing.T, phone *strictPhone) ([]PairStage, error) {
	t.Helper()
	record, _ := testRecord(t)
	service := &tunnelService{controlChannel: newControlChannelReadWriter(phone), record: record}
	stages := []PairStage{}
	err := service.pairSetup(PairHost{Name: "Test Mac", Model: "Mac15,9"}, func(s PairStage) { stages = append(stages, s) })
	if phone.reset {
		t.Fatalf("phone reset the stream after %v", phone.seen)
	}
	return stages, err
}

func TestPairSetupOpensVerifyBeforeSetup(t *testing.T) {
	phone := &strictPhone{mode: "unavailable", setupAllowed: true}
	stages, err := runPairSetup(t, phone)
	if !errors.Is(err, ErrRemotePairingUnavailable) {
		t.Fatalf("got %v", err)
	}
	want := "handshake verifyManualPairing:1 pairVerifyFailed setupManualPairing:1"
	if got := strings.Join(phone.seen, " "); got != want {
		t.Fatalf("order %q, want %q", got, want)
	}
	if len(phone.setupHosts) != 1 || phone.setupHosts[0] != "Test Mac" {
		t.Fatalf("setup sendingHost %q", phone.setupHosts)
	}
	if len(stages) != 1 || stages[0] != PairStageAwaitingConsent {
		t.Fatalf("stages %v", stages)
	}
}

func TestPairSetupReportsTheOwnersRefusal(t *testing.T) {
	_, err := runPairSetup(t, &strictPhone{mode: "denied", setupAllowed: true})
	if !errors.Is(err, ErrRemotePairingDenied) || !strings.Contains(err.Error(), "The person declined") {
		t.Fatalf("got %v", err)
	}
}

func TestPairSetupStopsWhenThePhoneRefusesNewPairings(t *testing.T) {
	phone := &strictPhone{setupAllowed: false}
	_, err := runPairSetup(t, phone)
	if !errors.Is(err, ErrRemotePairingUnavailable) || strings.Join(phone.seen, " ") != "handshake" {
		t.Fatalf("got %v after %v", err, phone.seen)
	}
}

func TestPairSetupNamesTheHostThroughSRP(t *testing.T) {
	phone := &strictPhone{mode: "srp", setupAllowed: true}
	_, err := runPairSetup(t, phone)
	if !errors.Is(err, ErrRemotePeerProof) {
		t.Fatalf("got %v", err)
	}
	if strings.Join(phone.setupHosts, ",") != "Test Mac,Test Mac" {
		t.Fatalf("sendingHost %v", phone.setupHosts)
	}
}

func TestStrictPhoneResetsTheOldOrder(t *testing.T) {
	phone := &strictPhone{setupAllowed: true}
	channel := newControlChannelReadWriter(phone)
	if err := channel.writeEvent(pairVerifyFailed{}); err != nil {
		t.Fatal(err)
	}
	if _, err := channel.read(); !errors.Is(err, errStreamClosed) {
		t.Fatalf("fake phone accepted pairVerifyFailed without Verify: %v", err)
	}
}
