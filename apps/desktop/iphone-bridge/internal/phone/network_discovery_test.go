package phone

import (
	"encoding/base64"
	"net/netip"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func testLAN() LANInterface {
	return LANInterface{Name: "en-test", Index: 9, Prefixes: []netip.Prefix{netip.MustParsePrefix("192.0.2.4/24"), netip.MustParsePrefix("fe80::4/64")}}
}
func TestRemotePairingAuthAndAmbiguity(t *testing.T) {
	now := time.Unix(1000, 0)
	// Newly authored SipHash input, independently checked with the reference algorithm.
	irk := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	c := NetworkCandidate{Identifier: "fixture-remote-phone", AuthTag: "kvSmScoX", Address: netip.MustParseAddr("192.0.2.8"), Port: 1234, Interface: testLAN(), Expires: now.Add(time.Minute)}
	if got := base64.StdEncoding.EncodeToString(remoteAuthTag(irk, c.Identifier)); got != c.AuthTag {
		t.Fatalf("auth vector: %s", got)
	}
	if !matchRemoteCandidate(c, irk, now) {
		t.Fatal("valid vector refused")
	}
	c.AuthTag = "AAAAAA=="
	if matchRemoteCandidate(c, irk, now) {
		t.Fatal("bad tag accepted")
	}
	c.AuthTag = base64.StdEncoding.EncodeToString(remoteAuthTag(irk, c.Identifier))
	other := c
	other.Address = netip.MustParseAddr("192.0.2.9")
	other.Identifier = "another-paired-advertisement"
	other.AuthTag = base64.StdEncoding.EncodeToString(remoteAuthTag(irk, other.Identifier))
	if _, err := selectRemoteCandidate([]NetworkCandidate{c, other}, irk, now); err == nil {
		t.Fatal("ambiguous signed advertisements selected a phone")
	}
	other = c
	other.Address = netip.MustParseAddr("198.51.100.8")
	if matchRemoteCandidate(other, irk, now) {
		t.Fatal("off-LAN endpoint accepted")
	}
	other = c
	other.Address = netip.MustParseAddr("fe80::8%en-test")
	if !matchRemoteCandidate(other, irk, now) {
		t.Fatal("scoped IPv6 lost")
	}
	other.Address = netip.MustParseAddr("fe80::8")
	if matchRemoteCandidate(other, irk, now) {
		t.Fatal("unscoped IPv6 accepted")
	}
	other = c
	other.Expires = now
	if matchRemoteCandidate(other, irk, now) {
		t.Fatal("expired endpoint accepted")
	}
}
func TestMDNSCacheComposesSplitRecordsAndExpires(t *testing.T) {
	now := time.Unix(1000, 0)
	service := dnsmessage.MustNewName(remotePairingService)
	instance := dnsmessage.MustNewName("fixture." + remotePairingService)
	host := dnsmessage.MustNewName("fixture.local.")
	resource := func(name dnsmessage.Name, kind dnsmessage.Type, body dnsmessage.ResourceBody) dnsmessage.Resource {
		return dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: name, Type: kind, Class: dnsmessage.ClassINET, TTL: 60}, Body: body}
	}
	records := []dnsmessage.Resource{
		resource(service, dnsmessage.TypePTR, &dnsmessage.PTRResource{PTR: instance}),
		resource(instance, dnsmessage.TypeSRV, &dnsmessage.SRVResource{Target: host, Port: 5000}),
		resource(instance, dnsmessage.TypeTXT, &dnsmessage.TXTResource{TXT: []string{"identifier=fixture-remote-phone", "authTag=kvSmScoX"}}),
		resource(host, dnsmessage.TypeAAAA, &dnsmessage.AAAAResource{AAAA: netip.MustParseAddr("fe80::8").As16()}),
	}
	cache := mdnsCache{}
	for _, r := range records {
		packet, err := (&dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Answers: []dnsmessage.Resource{r}}).Pack()
		if err != nil {
			t.Fatal(err)
		}
		if err := cache.ingest(packet, now); err != nil {
			t.Fatal(err)
		}
	}
	candidates := cache.candidates(testLAN(), now)
	if len(candidates) != 1 || candidates[0].Address.String() != "fe80::8%en-test" {
		t.Fatal("split/scoped mDNS failed")
	}
	if len(cache.candidates(testLAN(), now.Add(time.Minute))) != 0 {
		t.Fatal("expired candidate retained")
	}
	for _, r := range records {
		packet, _ := (&dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Answers: []dnsmessage.Resource{r}}).Pack()
		_ = cache.ingest(packet, now)
	}
	goodbye := records[0]
	goodbye.Header.TTL = 0
	packet, _ := (&dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Answers: []dnsmessage.Resource{goodbye}}).Pack()
	_ = cache.ingest(packet, now)
	if len(cache.candidates(testLAN(), now)) != 0 {
		t.Fatal("goodbye retained candidate")
	}
}
