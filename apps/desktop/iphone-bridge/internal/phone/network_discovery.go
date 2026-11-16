package phone

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/dchest/siphash"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

const remotePairingService = "_remotepairing._tcp.local."

type LANInterface struct {
	Name     string
	Index    int
	Prefixes []netip.Prefix
}
type NetworkCandidate struct {
	Instance   string
	Identifier string
	AuthTag    string
	Address    netip.Addr
	Port       uint16
	Interface  LANInterface
	Expires    time.Time
}

// Only directly attached Ethernet/Wi-Fi prefixes are eligible; tunnel/VPN interfaces are excluded.
func lanInterfaces() ([]LANInterface, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	result := []LANInterface{}
	for _, i := range interfaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagMulticast == 0 || i.Flags&net.FlagLoopback != 0 || !strings.HasPrefix(i.Name, "en") {
			continue
		}
		addresses, err := i.Addrs()
		if err != nil {
			continue
		}
		item := LANInterface{Name: i.Name, Index: i.Index}
		for _, a := range addresses {
			p, err := netip.ParsePrefix(a.String())
			if err == nil {
				item.Prefixes = append(item.Prefixes, p)
			}
		}
		if len(item.Prefixes) > 0 {
			result = append(result, item)
		}
	}
	return result, nil
}
func (c NetworkCandidate) validEndpoint(now time.Time) bool {
	a := c.Address.WithZone("")
	if c.Port == 0 || !now.Before(c.Expires) || !a.IsValid() || a.IsUnspecified() || a.IsMulticast() || a.IsLoopback() || c.Interface.Name == "" || c.Interface.Index < 1 {
		return false
	}
	if c.Address.Is6() && a.IsLinkLocalUnicast() {
		return c.Address.Zone() == c.Interface.Name
	}
	if c.Address.Zone() != "" {
		return false
	}
	for _, p := range c.Interface.Prefixes {
		if p.Contains(a) && a != p.Addr() {
			return true
		}
	}
	return false
}
func remoteAuthTag(irk []byte, identifier string) []byte {
	if len(irk) != 16 || len(identifier) == 0 || len(identifier) > 128 {
		return nil
	}
	sum := siphash.Hash(binary.LittleEndian.Uint64(irk[:8]), binary.LittleEndian.Uint64(irk[8:]), []byte(identifier))
	tag := make([]byte, 6)
	for i := range tag {
		tag[i] = byte(sum >> uint(8*(5-i)))
	}
	return tag
}
func matchRemoteCandidate(c NetworkCandidate, irk []byte, now time.Time) bool {
	if !c.validEndpoint(now) {
		return false
	}
	tag, err := base64.StdEncoding.Strict().DecodeString(c.AuthTag)
	if err != nil || len(tag) != 6 {
		return false
	}
	expected := remoteAuthTag(irk, c.Identifier)
	return len(expected) == 6 && subtle.ConstantTimeCompare(tag, expected) == 1
}
func selectRemoteCandidate(candidates []NetworkCandidate, irk []byte, now time.Time) (NetworkCandidate, error) {
	var selected NetworkCandidate
	found := false
	for _, c := range candidates {
		if !matchRemoteCandidate(c, irk, now) {
			continue
		}
		if found && (selected.Instance != c.Instance || selected.Identifier != c.Identifier || selected.Port != c.Port) {
			return NetworkCandidate{}, wire.Fail(wire.WifiIdentityMismatch)
		}
		if !found || (c.Address.Is4() && !selected.Address.Is4()) || (c.Address.Is4() == selected.Address.Is4() && c.Address.Compare(selected.Address) < 0) {
			selected = c
		}
		found = true
	}
	if !found {
		return NetworkCandidate{}, wire.Fail(wire.WifiPhoneNotFound)
	}
	return selected, nil
}

type mdnsRecord struct {
	resource dnsmessage.Resource
	expires  time.Time
}
type mdnsCache struct{ records map[string]mdnsRecord }

func (c *mdnsCache) ingest(packet []byte, now time.Time) error {
	var message dnsmessage.Message
	if err := message.Unpack(packet); err != nil {
		return err
	}
	if !message.Header.Response {
		return nil
	}
	if c.records == nil {
		c.records = make(map[string]mdnsRecord)
	}
	records := append(append(message.Answers, message.Authorities...), message.Additionals...)
	for _, r := range records {
		if len(c.records) >= 256 {
			return wire.Fail(wire.WifiTransportUnsupported)
		}
		// Cache identity includes RDATA so multi-address answers cannot overwrite each other.
		ttl := min(r.Header.TTL, 120)
		r.Header.TTL = 0
		stable, _ := (&dnsmessage.Message{Answers: []dnsmessage.Resource{r}}).Pack()
		key := string(stable)
		if recordsTTL := ttl; recordsTTL == 0 {
			delete(c.records, key)
		} else {
			c.records[key] = mdnsRecord{r, now.Add(time.Duration(recordsTTL) * time.Second)}
		}
	}
	return nil
}
func (c *mdnsCache) candidates(i LANInterface, now time.Time) []NetworkCandidate {
	records := []mdnsRecord{}
	for key, r := range c.records {
		if !now.Before(r.expires) {
			delete(c.records, key)
		} else {
			records = append(records, r)
		}
	}
	result := []NetworkCandidate{}
	for _, r := range records {
		ptr, ok := r.resource.Body.(*dnsmessage.PTRResource)
		if !ok || !strings.EqualFold(r.resource.Header.Name.String(), remotePairingService) {
			continue
		}
		for _, srvRecord := range records {
			srv, ok := srvRecord.resource.Body.(*dnsmessage.SRVResource)
			if !ok || srvRecord.resource.Header.Name != ptr.PTR {
				continue
			}
			identifier, tag := "", ""
			bad := false
			expiry := minTime(r.expires, srvRecord.expires)
			for _, txtRecord := range records {
				txt, ok := txtRecord.resource.Body.(*dnsmessage.TXTResource)
				if !ok || txtRecord.resource.Header.Name != ptr.PTR {
					continue
				}
				expiry = minTime(expiry, txtRecord.expires)
				for _, v := range txt.TXT {
					k, v, ok := strings.Cut(v, "=")
					if !ok {
						continue
					}
					switch k {
					case "identifier":
						if identifier != "" {
							bad = true
						}
						identifier = v
					case "authTag":
						if tag != "" {
							bad = true
						}
						tag = v
					}
				}
			}
			if bad || identifier == "" || tag == "" {
				continue
			}
			for _, aRecord := range records {
				if aRecord.resource.Header.Name != srv.Target {
					continue
				}
				var addr netip.Addr
				switch a := aRecord.resource.Body.(type) {
				case *dnsmessage.AResource:
					addr = netip.AddrFrom4(a.A)
				case *dnsmessage.AAAAResource:
					addr = netip.AddrFrom16(a.AAAA)
					if addr.IsLinkLocalUnicast() {
						addr = addr.WithZone(i.Name)
					}
				default:
					continue
				}
				result = append(result, NetworkCandidate{ptr.PTR.String(), identifier, tag, addr, srv.Port, i, minTime(expiry, aRecord.expires)})
			}
		}
	}
	return result
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

type mdnsPacket struct {
	packet []byte
	iface  LANInterface
	err    error
}

// Discovery is a bounded, on-demand contingency probe. It never runs beside a usable system route.
func browseRemote(ctx context.Context) ([]NetworkCandidate, error) {
	interfaces, err := lanInterfaces()
	if err != nil {
		return nil, networkFailure(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	var readers sync.WaitGroup
	defer func() { cancel(); readers.Wait() }()
	packets := make(chan mdnsPacket, 32)
	connections := []net.PacketConn{}
	defer func() {
		for _, c := range connections {
			_ = c.Close()
		}
	}()
	service, _ := dnsmessage.NewName(remotePairingService)
	query, _ := (&dnsmessage.Message{Questions: []dnsmessage.Question{{Name: service, Type: dnsmessage.TypePTR, Class: dnsmessage.ClassINET | 0x8000}}}).Pack()
	for _, i := range interfaces {
		for _, family := range []string{"udp4", "udp6"} {
			c, err := net.ListenPacket(family, ":0")
			if err != nil {
				if networkFailure(err).Code == wire.LocalNetworkPermissionRequired {
					return nil, networkFailure(err)
				}
				continue
			}
			connections = append(connections, c)
			if family == "udp4" {
				p := ipv4.NewPacketConn(c)
				_ = p.SetMulticastInterface(&net.Interface{Index: i.Index})
				_, err = p.WriteTo(query, nil, &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353})
			} else {
				p := ipv6.NewPacketConn(c)
				_ = p.SetMulticastInterface(&net.Interface{Index: i.Index})
				_, err = p.WriteTo(query, nil, &net.UDPAddr{IP: net.ParseIP("ff02::fb"), Port: 5353, Zone: i.Name})
			}
			if err != nil {
				if errors.Is(err, net.ErrClosed) {
					continue
				}
				if networkFailure(err).Code == wire.LocalNetworkPermissionRequired {
					return nil, networkFailure(err)
				}
				continue
			}
			readers.Add(1)
			go func(c net.PacketConn, i LANInterface) {
				defer readers.Done()
				stop := context.AfterFunc(ctx, func() { _ = c.Close() })
				defer stop()
				buffer := make([]byte, 9000)
				for {
					n, source, err := c.ReadFrom(buffer)
					if err != nil {
						select {
						case packets <- mdnsPacket{err: err}:
						case <-ctx.Done():
						}
						return
					}
					udp, ok := source.(*net.UDPAddr)
					if !ok || udp.Port != 5353 {
						continue
					}
					select {
					case packets <- mdnsPacket{packet: append([]byte{}, buffer[:n]...), iface: i}:
					case <-ctx.Done():
						return
					}
				}
			}(c, i)
		}
	}
	if len(connections) == 0 {
		return nil, wire.Fail(wire.WifiPhoneNotFound)
	}
	caches := map[int]*mdnsCache{}
	var quiet *time.Timer
	var quietC <-chan time.Time

	for {
		select {
		case <-ctx.Done():
			if quiet != nil {
				quiet.Stop()
			}
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, ctx.Err()
			}
			return gatherCandidates(caches, interfaces), nil
		case <-quietC:
			return gatherCandidates(caches, interfaces), nil
		case p := <-packets:
			if p.err != nil {
				if networkFailure(p.err).Code == wire.LocalNetworkPermissionRequired {
					return nil, networkFailure(p.err)
				}
				continue
			}
			cache := caches[p.iface.Index]
			if cache == nil {
				cache = &mdnsCache{}
				caches[p.iface.Index] = cache
			}
			if cache.ingest(p.packet, time.Now()) != nil {
				continue
			}
			if len(cache.candidates(p.iface, time.Now())) > 0 && quiet == nil {
				quiet = time.NewTimer(200 * time.Millisecond)
				defer quiet.Stop()
				quietC = quiet.C
			}
		}
	}
}
func gatherCandidates(caches map[int]*mdnsCache, interfaces []LANInterface) []NetworkCandidate {
	result := []NetworkCandidate{}
	for _, i := range interfaces {
		if c := caches[i.Index]; c != nil {
			result = append(result, c.candidates(i, time.Now())...)
		}
	}
	return result
}
