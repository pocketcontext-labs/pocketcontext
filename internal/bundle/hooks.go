package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"

	"ganigeorgiev.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/dop251/goja"
)

// hooksConfig loads pb_hooks and pb_migrations from appDir with PocketContext's
// own bindings. typesDir receives PocketBase's types.d.ts; never the project.
func hooksConfig(appDir, typesDir string) jsvm.Config {
	return jsvm.Config{
		HooksDir:      filepath.Join(appDir, "pb_hooks"),
		MigrationsDir: filepath.Join(appDir, "pb_migrations"),
		TypesDir:      typesDir,
		HooksWatch:    false,
		OnInit:        registerHookBindings,
	}
}

// registerHookBindings adds $pocketcontext to every hook and migration runtime.
// Hooks must not start external processes (stock Windows has no sha256sum),
// so anything they cannot do in JavaScript is provided here in Go.
func registerHookBindings(vm *goja.Runtime) {
	vm.Set("$pocketcontext", map[string]any{
		// sha256(reader) streams the raw bytes of reader (for example a
		// filesystem reader of an original) and returns the lowercase hex digest.
		"sha256": readerSHA256,
	})
}

func readerSHA256(r io.Reader) (string, error) {
	if r == nil {
		return "", errors.New("sha256: no reader")
	}
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
