package phone

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"reflect"
	"testing"
	"time"

	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/danielpaulus/go-ios/ios/xpc"
)

type fixtureDialer struct {
	conn    net.Conn
	service string
}

func (d *fixtureDialer) DialService(_ context.Context, name string) (net.Conn, error) {
	d.service = name
	return d.conn, nil
}
func (d *fixtureDialer) OpenXPC(context.Context, string) (*xpc.Connection, error) { return nil, io.EOF }
func (d *fixtureDialer) Close() error                                             { return d.conn.Close() }
func TestRemoteAXRawDTXACKAndDisableOnCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	_ = server.SetDeadline(time.Now().Add(2 * time.Second))
	dial := &fixtureDialer{conn: client}
	done := make(chan error, 1)
	go func() {
		c := dtx.NewRawConnection(server)
		for _, selector := range []string{"_notifyOfPublishedCapabilities:", "clientNeedsAccessibility:"} {
			m, e := c.Read()
			if e != nil {
				done <- e
				return
			}
			if len(m.Payload) != 1 || m.Payload[0] != selector {
				done <- io.ErrUnexpectedEOF
				return
			}
		}
		dump := axDump(axUpdate(4, map[string]interface{}{"objectID": uint64(1)}), axAttributes(1, map[string]interface{}{"8": []interface{}{uint64(2)}}), axAttributes(2, map[string]interface{}{"33": "Fixture"}))
		data, e := nskeyedarchiver.ArchiveBin(dump)
		if e != nil {
			done <- e
			return
		}
		aux := dtx.NewPrimitiveDictionary()
		aux.AddBytes(data)
		payload, e := nskeyedarchiver.ArchiveBin("fixtureCallback:")
		if e != nil {
			done <- e
			return
		}
		packet, e := dtx.Encode(20, 0, 0, true, dtx.Methodinvocation, payload, aux)
		if e != nil {
			done <- e
			return
		}
		if e = c.Send(packet); e != nil {
			done <- e
			return
		}
		ack, e := c.Read()
		if e != nil {
			done <- e
			return
		}
		if ack.Identifier != 20 || ack.ConversationIndex != 1 || ack.PayloadHeader.MessageType != dtx.Ack {
			done <- io.ErrUnexpectedEOF
			return
		}
		cancel()
		disabled, e := c.Read()
		if e != nil {
			done <- e
			return
		}
		if len(disabled.Payload) != 1 || disabled.Payload[0] != "clientNeedsAccessibility:" {
			done <- io.ErrUnexpectedEOF
			return
		}
		arg := disabled.Auxiliary.GetArguments()[0].([]byte)
		values, e := nskeyedarchiver.Unarchive(arg)
		if e != nil {
			done <- e
			return
		}
		if len(values) != 1 || values[0] != false {
			done <- io.ErrUnexpectedEOF
			return
		}
		done <- nil
	}()
	_, _ = collectRemoteAX(ctx, dial)
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("AX peer never received ACK and disable")
	}
	if dial.service != remoteAXService {
		t.Fatal("AX used an XPC/audit endpoint")
	}
}
func TestRawDTXRejectsLengthsBeforeAllocation(t *testing.T) {
	for _, length := range []uint32{0, 15, 16<<20 + 1, 0xffffffff} {
		a, b := net.Pipe()
		done := make(chan error, 1)
		go func() {
			defer b.Close()
			var h [32]byte
			binary.BigEndian.PutUint32(h[:], dtx.DtxMessageMagic)
			binary.LittleEndian.PutUint32(h[4:], 32)
			binary.LittleEndian.PutUint16(h[10:], 1)
			binary.LittleEndian.PutUint32(h[12:], length)
			_, err := b.Write(h[:])
			done <- err
		}()
		_ = a.SetDeadline(time.Now().Add(time.Second))
		if _, err := dtx.NewRawConnection(a).Read(); err == nil {
			t.Fatal("invalid length accepted")
		}
		a.Close()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestRawDTXBoundsTheAuxiliarySection(t *testing.T) {
	payload, e := nskeyedarchiver.ArchiveBin("fixture-selector")
	if e != nil {
		t.Fatal(e)
	}
	for _, size := range []int{64 << 10, 1<<20 + 1} {
		aux := dtx.NewPrimitiveDictionary()
		aux.AddBytes(make([]byte, size))
		packet, e := dtx.Encode(1, 0, 0, false, dtx.Methodinvocation, payload, aux)
		if e != nil {
			t.Fatal(e)
		}
		// Apple sizes this capacity field to the message; it is not always 496.
		binary.LittleEndian.PutUint32(packet[48:], uint32(size+512))
		a, b := net.Pipe()
		go func() { _, _ = b.Write(packet); b.Close() }()
		_ = a.SetDeadline(time.Now().Add(time.Second))
		_, err := dtx.NewRawConnection(a).Read()
		a.Close()
		if (err == nil) != (size < 1<<20) {
			t.Fatalf("auxiliary of %d bytes: %v", size, err)
		}
	}
}

func TestRawDTXReassemblesOnlyMatchingBoundedFragments(t *testing.T) {
	payload, e := nskeyedarchiver.ArchiveBin("fixture-selector")
	if e != nil {
		t.Fatal(e)
	}
	packet, e := dtx.Encode(12, 0, 0, false, dtx.Methodinvocation, payload, dtx.NewPrimitiveDictionary())
	if e != nil {
		t.Fatal(e)
	}
	var stream bytes.Buffer
	first := append([]byte{}, packet[:32]...)
	binary.LittleEndian.PutUint16(first[10:], 3)
	stream.Write(first)
	body := packet[32:]
	split := len(body) / 2
	for i, part := range [][]byte{body[:split], body[split:]} {
		h := append([]byte{}, first...)
		binary.LittleEndian.PutUint16(h[8:], uint16(i+1))
		binary.LittleEndian.PutUint32(h[12:], uint32(len(part)))
		stream.Write(h)
		stream.Write(part)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_ = a.SetDeadline(time.Now().Add(time.Second))
	_ = b.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() { _, err := b.Write(stream.Bytes()); done <- err }()
	m, e := dtx.NewRawConnection(a).Read()
	if e != nil || len(m.Payload) != 1 || m.Payload[0] != "fixture-selector" {
		t.Fatalf("fragment assembly failed: %v", e)
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}
func TestRemoteAXNoHierarchyIsUnavailableAndDisables(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_ = b.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		c := dtx.NewRawConnection(b)
		for range 2 {
			if _, e := c.Read(); e != nil {
				done <- e
				return
			}
		}
		cancel()
		m, e := c.Read()
		if e == nil && (len(m.Payload) != 1 || m.Payload[0] != "clientNeedsAccessibility:") {
			e = io.ErrUnexpectedEOF
		}
		done <- e
	}()
	_, e := collectRemoteAX(ctx, &fixtureDialer{conn: a})
	if e == nil {
		t.Fatal("no hierarchy reported success")
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}

func hubFixtureRecord(id uint64, attributes map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"UIAccessibilitySnapshotKeyElement":    map[string]interface{}{"pid": uint64(77), "objectID": id},
		"UIAccessibilitySnapshotKeyAttributes": attributes,
	}
}

func TestDeviceHubFocusQueriesAndRedactsSecureRecord(t *testing.T) {
	for _, secure := range []bool{false, true} {
		client, server := net.Pipe()
		_ = server.SetDeadline(time.Now().Add(time.Second))
		t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
		dial := &fixtureDialer{conn: client}
		done := make(chan error, 1)
		go func() {
			c := dtx.NewRawConnection(server)
			done <- simulateHubFocus(c, secure)
		}()
		focus, err := readHubFocus(context.Background(), dial, AXFrame{Width: 390, Height: 844}, 0)
		if err != nil {
			t.Fatal(err)
		}
		if dial.service != deviceHubAXService || focus.ID != 2 || focus.Editable != "yes" {
			t.Fatal("focused element facts missing")
		}
		if secure {
			if focus.Secure != "yes" || focus.Value != nil {
				t.Fatal("secure value escaped")
			}
		} else if focus.Secure != "no" || focus.Value == nil || *focus.Value != "fixture value" {
			t.Fatal("readback mismatch")
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}
func simulateHubFocus(c *dtx.RawConnection, secure bool) error {
	read := func(selector string) (dtx.Message, error) {
		m, err := c.Read()
		if err == nil && (len(m.Payload) != 1 || m.Payload[0] != selector) {
			err = fmt.Errorf("wrong selector for %s", selector)
		}
		return m, err
	}
	if _, err := read("_notifyOfPublishedCapabilities:"); err != nil {
		return err
	}
	if _, err := read("clientNeedsAccessibility:"); err != nil {
		return err
	}
	basic := uint64(1 << 18)
	if secure {
		basic |= 1 << 24
	}
	field := hubFixtureRecord(2, map[string]interface{}{"2004": basic})
	token := map[string]interface{}{"pid": uint64(77), "objectID": uint64(1), "isApplicationElement": true}
	responses := []struct {
		request int
		result  interface{}
	}{
		{6, map[string]interface{}{"pid": uint64(77), "objectID": uint64(2)}},
		{1, token},
		{2, hubFixtureRecord(1, map[string]interface{}{"3002": field})},
	}
	if !secure {
		responses = append(responses, struct {
			request int
			result  interface{}
		}{2, hubFixtureRecord(2, map[string]interface{}{"2004": basic, "2006": "fixture value"})})
	}
	for i, response := range responses {
		m, err := read("processDataFromHost:")
		if err != nil {
			return err
		}
		req := hubResponse(m.Auxiliary.GetArguments()[0])
		kind, _ := unsigned(req["requestType"])
		if uint64(response.request) != kind {
			return fmt.Errorf("wrong AX request type %d", kind)
		}
		if i == 2 || i == 3 {
			params, _ := req["parameters"].(map[string]interface{})
			options, _ := params["parameter"].(map[string]interface{})
			if !reflect.DeepEqual(ids(options["attributes"]), map[int][]uint64{2: {3002, 2004}, 3: {2004, 2006}}[i]) {
				return fmt.Errorf("unexpected focus attributes")
			}
		}
		if err := c.Send(dtx.BuildAckMessage(m)); err != nil {
			return err
		}
		body, err := axCall(11+i, "processDataFromRemoteDevice:", map[string]interface{}{
			"associatedRequestType": response.request, "resultData": response.result, "error": 0,
		})
		if err != nil {
			return err
		}
		if err := c.Send(body); err != nil {
			return err
		}
	}
	_, err := read("clientNeedsAccessibility:")
	return err
}
