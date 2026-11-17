package ios

import (
	"errors"
	"net"
	"testing"
	"time"
)

func TestGetValueRejectsDeviceErrorEvenWithValue(t *testing.T) {
	client, peer := net.Pipe()
	defer client.Close()
	defer peer.Close()
	_ = client.SetDeadline(time.Now().Add(time.Second))
	_ = peer.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		codec := NewPlistCodecReadWriter(peer, peer)
		var request map[string]interface{}
		if err := codec.Read(&request); err != nil {
			done <- err
			return
		}
		done <- codec.Write(map[string]interface{}{"Error": "InvalidHostID", "Value": false})
	}()
	conn := NewLockDownConnection(NewDeviceConnectionWithConn(client))
	_, err := conn.GetValue("PasswordProtected")
	var rejection *LockdownError
	if !errors.As(err, &rejection) || rejection.Code != "InvalidHostID" {
		t.Fatalf("device error treated as readable value: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("lockdown fixture did not finish")
	}
}
