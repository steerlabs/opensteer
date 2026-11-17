package amfi

import (
	"github.com/danielpaulus/go-ios/ios"
	"net"
	"testing"
	"time"
)

func TestRevealOnlySendsActionZeroAndRequiresSuccess(t *testing.T) {
	for _, reply := range []map[string]interface{}{{"success": true}, {"success": false}, {"Error": "denied"}, {}} {
		client, peer := net.Pipe()
		_ = client.SetDeadline(time.Now().Add(time.Second))
		_ = peer.SetDeadline(time.Now().Add(time.Second))
		done := make(chan error, 1)
		go func() {
			defer peer.Close()
			rw := ios.NewPlistCodecReadWriter(peer, peer)
			var request map[string]interface{}
			err := rw.Read(&request)
			if err == nil {
				if request["action"] != uint64(0) || len(request) != 1 {
					t.Error("AMFI reveal requested another action")
				}
				err = rw.Write(reply)
			}
			done <- err
		}()
		conn := &Connection{deviceConn: ios.NewDeviceConnectionWithConn(client), plistCodec: ios.NewPlistCodec()}
		err := conn.RevealDevMode()
		conn.Close()
		if (err == nil) != (reply["success"] == true) {
			t.Fatalf("reply %+v: %v", reply, err)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("AMFI request did not finish")
		}
	}
}
