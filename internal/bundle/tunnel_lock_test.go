package bundle

import "testing"

func TestTunnelLockPreventsConcurrentRotation(t *testing.T) {
	p := &Project{Cache: t.TempDir()}
	release, err := AcquireTunnelLock(p)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := AcquireTunnelLock(p); err == nil {
		second()
		release()
		t.Fatal("a second tunnel acquired the lock")
	}
	release()
	release, err = AcquireTunnelLock(p)
	if err != nil {
		t.Fatal(err)
	}
	release()
}
