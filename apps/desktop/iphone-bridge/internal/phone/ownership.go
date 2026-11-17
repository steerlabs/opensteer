package phone

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"syscall"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type Owner struct {
	DeploymentID     string `json:"deploymentId"`
	HostInstanceID   string `json:"hostInstanceId"`
	RunnerID         string `json:"runnerId"`
	DeviceID         string `json:"deviceId"`
	DriverGeneration uint64 `json:"driverGeneration"`
}
type Reservation struct {
	file  *os.File
	owner Owner
}

func Reserve(root *os.Root, identity string, owner Owner) (*Reservation, error) {
	digest := sha256.Sum256([]byte(identity))
	name := "ownership-" + hex.EncodeToString(digest[:]) + ".json"
	f, err := root.OpenFile(name, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, wire.Fail(wire.OwnedElsewhere)
	}
	fail := func() (*Reservation, error) { f.Close(); return nil, wire.Fail(wire.OwnedElsewhere) }
	info, err := f.Stat()
	if err != nil || !privateFile(info) {
		return fail()
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail()
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		return fail()
	}
	var previous Owner
	if len(data) > 0 {
		if wire.StrictDecode(data, &previous) != nil || previous != owner {
			return fail()
		}
		return &Reservation{f, owner}, nil
	}
	data, err = json.Marshal(owner)
	if err != nil {
		return fail()
	}
	if err := f.Truncate(0); err != nil {
		return fail()
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fail()
	}
	if _, err := f.Write(data); err != nil {
		return fail()
	}
	if err := f.Sync(); err != nil {
		return fail()
	}
	return &Reservation{f, owner}, nil
}
func (r *Reservation) Close() error { return r.file.Close() }
func (r *Reservation) Forget() error {
	if err := r.file.Truncate(0); err != nil {
		return err
	}
	return r.file.Sync()
}

func LockUnbound(root *os.Root, identity string) (*os.File, error) {
	digest := sha256.Sum256([]byte(identity))
	name := "ownership-" + hex.EncodeToString(digest[:]) + ".json"
	f, err := root.OpenFile(name, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, wire.Fail(wire.OwnedElsewhere)
	}
	info, err := f.Stat()
	if err != nil || !privateFile(info) || info.Size() != 0 {
		f.Close()
		return nil, wire.Fail(wire.OwnedElsewhere)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, wire.Fail(wire.OwnedElsewhere)
	}
	info, err = f.Stat()
	if err != nil || info.Size() != 0 {
		f.Close()
		return nil, wire.Fail(wire.OwnedElsewhere)
	}
	return f, nil
}

func LockIdentityStore(root *os.Root) (*os.File, error) {
	f, err := root.OpenFile("identities.lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, wire.Fail(wire.PhoneInUse)
	}
	info, err := f.Stat()
	if err != nil || !privateFile(info) {
		f.Close()
		return nil, wire.Fail(wire.PhoneInUse)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, wire.Fail(wire.PhoneInUse)
	}
	return f, nil
}

func privateFile(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && stat.Nlink == 1 && info.Mode().IsRegular() && info.Mode().Perm() == 0600
}
