package phone

import (
	"os"
	"testing"
)

func TestDurableOwnershipAndNonDeletingLock(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	owner := Owner{"deployment-a", "host-a", "runner-a", "device-a", 1}
	first, err := Reserve(root, "synthetic-phone", owner)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := Reserve(root, "synthetic-phone", owner); err == nil {
		other.Close()
		t.Fatal("second process acquired held lock")
	}
	first.Close()
	another := owner
	another.DeploymentID = "deployment-b"
	if other, err := Reserve(root, "synthetic-phone", another); err == nil {
		other.Close()
		t.Fatal("crash transferred durable owner")
	}
	first, err = Reserve(root, "synthetic-phone", owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Forget(); err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := Reserve(root, "synthetic-phone", another)
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
	if lock, err := LockUnbound(root, "synthetic-phone"); err == nil {
		lock.Close()
		t.Fatal("setup stole a reservation")
	}
}
