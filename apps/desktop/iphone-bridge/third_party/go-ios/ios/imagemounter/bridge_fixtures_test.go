package imagemounter

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"howett.net/plist"
)

type closeFixture struct{}

func (closeFixture) Close() error { return nil }

type transportFixture func(*http.Request) (*http.Response, error)

func (f transportFixture) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCryptexReplyFixtures(t *testing.T) {
	for _, reply := range []map[string]interface{}{{"error": uint64(0), "argv": map[string]interface{}{"remote-cryptex-array": []interface{}{map[string]interface{}{"remote-cryptex-identifier": "com.apple.MobileAsset.DDI", "remote-cryptex-version": "fixture"}}}}, {"error": uint64(13)}, {"cferr": map[string]interface{}{"domain": "fixture", "code": int64(1)}}} {
		input, output := new(bytes.Buffer), new(bytes.Buffer)
		if err := xpc.EncodeMessage(input, xpc.Message{Flags: xpc.AlwaysSetFlag | xpc.DataFlag, Id: 1, Body: reply}); err != nil {
			t.Fatal(err)
		}
		conn, err := xpc.New(output, input, nil, closeFixture{})
		if err != nil {
			t.Fatal(err)
		}
		installed, err := listCryptexes(conn)
		failed := reply["cferr"] != nil || reply["error"] == uint64(13)
		if failed {
			if err == nil {
				t.Fatal("accepted cryptex failure")
			}
		} else if err != nil || len(installed) != 1 || installed[0].Version != "fixture" {
			t.Fatalf("cryptex reply %v %v", installed, err)
		}
		request, err := xpc.DecodeMessage(output)
		if err != nil || request.Body["routine"] != "copy-installed" {
			t.Fatal("wrong cryptex request")
		}
	}
}
func TestPersonalizedReplyFixtures(t *testing.T) {
	for _, status := range []string{"Complete", "Error"} {
		input, output := new(bytes.Buffer), new(bytes.Buffer)
		codec := ios.NewPlistCodecReadWriter(input, output)
		payload, err := ios.NewPlistCodec().Encode(map[string]interface{}{"Status": status})
		if err != nil {
			t.Fatal(err)
		}
		input.Write(payload)
		err = readImageMounterResponse(codec, "synthetic-identity", "MountImage", "Complete")
		if (err == nil) != (status == "Complete") {
			t.Fatalf("status %s: %v", status, err)
		}
	}
}
func TestTSSUsesCancellationAndBoundedReplies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	client := tssClient{ctx: ctx, h: &http.Client{Transport: transportFixture(func(r *http.Request) (*http.Response, error) {
		called = true
		if r.Context().Err() != context.Canceled {
			t.Fatal("lost setup cancellation")
		}
		return nil, r.Context().Err()
	})}}
	if _, err := client.requestTicket(map[string]interface{}{}, "ApImg4Ticket"); err == nil || !called {
		t.Fatal("canceled personalization accepted")
	}
	ticket, _ := plist.Marshal(map[string]interface{}{"ApImg4Ticket": []byte("synthetic-ticket")}, plist.XMLFormat)
	client = tssClient{ctx: context.Background(), h: &http.Client{Transport: transportFixture(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(append([]byte("STATUS=0&MESSAGE=SUCCESS&REQUEST_STRING="), ticket...)))}, nil
	})}}
	result, err := client.requestTicket(map[string]interface{}{}, "ApImg4Ticket")
	if err != nil || string(result) != "synthetic-ticket" {
		t.Fatalf("TSS fixture: %q %v", result, err)
	}
	if _, err := parseResponse(io.LimitReader(zeroReader{}, (4<<20)+1)); err == nil {
		t.Fatal("unbounded TSS reply")
	}
	var rejection *PersonalizationError
	client.h.Transport = transportFixture(func(*http.Request) (*http.Response, error) { return nil, errors.New("sentinel-private-key") })
	_, err = client.requestTicket(map[string]interface{}{}, "ApImg4Ticket")
	if !errors.As(err, &rejection) || !rejection.Network {
		t.Fatal("untyped network failure")
	}
}

type zeroReader struct{}

func (zeroReader) Read(b []byte) (int, error) { clear(b); return len(b), nil }

func TestCompatibleMountedCryptexBuild(t *testing.T) {
	for _, test := range []struct {
		installed, selected string
		want                bool
	}{
		{"27.2.52.0", "27.2.52.0", true}, {"27.2.53.0", "27.2.52.0", true}, {"27.2.52.1", "27.2.52.0", true}, {"27.2.51.0", "27.2.52.0", false}, {"28.2.52.0", "27.2.52.0", false}, {"27.3.52.0", "27.2.52.0", false}, {"27.2.invalid.0", "27.2.52.0", false},
	} {
		if got := compatibleCryptexBuild(test.installed, test.selected); got != test.want {
			t.Fatalf("%s vs %s: %v", test.installed, test.selected, got)
		}
	}
}

func TestDirectTunnelMounterDoesNotRequireUSBMuxVersionLookup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d := ios.DeviceEntry{DeviceID: -1, Context: ctx, Address: "fd00::2", Rsd: ios.RsdHandshakeResponse{Services: map[string]ios.RsdServiceEntry{cryptexServiceName: {Port: 1234}}}}
	m, err := NewImageMounter(d)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, ok := m.(*CryptexDeveloperDiskImageMounter); !ok {
		t.Fatal("direct tunnel required a usbmux-backed mounter")
	}
}
