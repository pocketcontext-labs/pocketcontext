package bundle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	_ "github.com/pocketbase/pocketbase/migrations" // system migrations
	"github.com/pocketbase/pocketbase/plugins/jsvm"

	wikicontextbundle "github.com/pocketcontext/wikicontext-bundle"
	"github.com/pocketcontext/wikicontext-bundle/internal/pocketcontext/database"
	"github.com/pocketcontext/wikicontext-bundle/internal/pocketcontext/server"
)

// Version and Commit are set at build time.
var (
	Version = "dev"
	Commit  = ""
)

// ServeOptions control one foreground server run.
type ServeOptions struct {
	TakeOver bool
}

// unpack writes the embedded application files to a content-addressed cache
// directory and returns it. Existing complete directories are reused.
func unpack(p *Project) (string, error) {
	type entry struct {
		name string
		data []byte
	}
	var entries []entry
	h := sha256.New()
	err := fs.WalkDir(wikicontextbundle.Assets, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := wikicontextbundle.Assets.ReadFile(name)
		if err != nil {
			return err
		}
		entries = append(entries, entry{name, data})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	for _, e := range entries {
		fmt.Fprintf(h, "%s\x00%d\x00", e.name, len(e.data))
		h.Write(e.data)
	}
	root := filepath.Join(filepath.Dir(p.Cache), "app")
	dir := filepath.Join(root, hex.EncodeToString(h.Sum(nil))[:16])
	if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	temp, err := os.MkdirTemp(root, ".unpack-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(temp)
	for _, e := range entries {
		path := filepath.Join(temp, filepath.FromSlash(e.name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, e.data, 0600); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(temp, ".complete"), nil, 0600); err != nil {
		return "", err
	}
	if err := os.Rename(temp, dir); err != nil {
		if _, statErr := os.Stat(filepath.Join(dir, ".complete")); statErr == nil {
			return dir, nil // another process unpacked the same version
		}
		return "", err
	}
	return dir, nil
}

// Serve runs the server in the foreground until interrupted or stopped.
func Serve(p *Project, opts ServeOptions) error {
	if err := os.MkdirAll(p.Cache, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(p.Cache, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockFile(lock); err != nil {
		return errors.New("a WikiContext server for this database is already running on this computer")
	}
	if _, err := os.Stat(p.ConfigPath); errors.Is(err, os.ErrNotExist) {
		if err := p.SaveConfig(); err != nil {
			return err
		}
	}
	if err := p.EnsureInstance(); err != nil {
		return err
	}
	if err := claimLease(p, opts.TakeOver); err != nil {
		return err
	}
	defer releaseLease(p)
	store := &Store{p: p}
	if err := store.Open(); err != nil {
		return err
	}
	appDir, err := unpack(p)
	if err != nil {
		return fmt.Errorf("unpacking application files: %w", err)
	}
	// The reader hook serves ui/dist relative to the working directory.
	if err := os.Chdir(appDir); err != nil {
		return err
	}
	key := RandomHex(32)
	if err := WriteAtomic(p.KeyFile(), []byte(key), 0600); err != nil {
		return err
	}
	defer os.Remove(p.KeyFile())

	live := p.LiveDir()
	controller, err := database.NewController(live)
	if err != nil {
		return fmt.Errorf("maintenance state: %w", err)
	}
	app := core.NewBaseApp(core.BaseAppConfig{
		// storage/ is created beside the database; the databases live in the cache.
		DataDir:      p.Dir,
		QueryTimeout: core.DefaultQueryTimeout,
		DBConnect: func(path string) (*dbx.DB, error) {
			return controller.Connect(filepath.Join(live, filepath.Base(path)))
		},
	})
	// PocketBase watches DataDir/.notify to coordinate processes that share one
	// pb_data. Here DataDir is the synced folder and each computer has its own
	// working copy, so the watcher would only leak events between computers.
	const notifyWatcher = "__pbNotifyWatcherSystemHook__"
	app.OnBootstrap().Unbind(notifyWatcher)
	app.OnTerminate().Unbind(notifyWatcher)
	app.OnModelAfterCreateSuccess().Unbind(notifyWatcher)
	app.OnModelAfterUpdateSuccess().Unbind(notifyWatcher)
	app.OnCollectionAfterCreateSuccess().Unbind(notifyWatcher)
	app.OnCollectionAfterUpdateSuccess().Unbind(notifyWatcher)
	app.OnCollectionAfterDeleteSuccess().Unbind(notifyWatcher)
	server.RegisterMaintenance(app, controller)
	jsvm.MustRegister(app, jsvm.Config{
		HooksDir:      filepath.Join(appDir, "pb_hooks"),
		MigrationsDir: filepath.Join(appDir, "pb_migrations"),
		TypesDir:      p.Cache,
		HooksWatch:    false,
	})
	server.RegisterDatabase(app, filepath.Join(appDir, "pocketcontext.json"), store.livePath())

	changed := func(e *core.ModelEvent) error {
		if _, isLog := e.Model.(*core.Log); !isLog {
			store.Changed()
		}
		return e.Next()
	}
	app.OnModelAfterCreateSuccess().BindFunc(changed)
	app.OnModelAfterUpdateSuccess().BindFunc(changed)
	app.OnModelAfterDeleteSuccess().BindFunc(changed)

	if err := app.Bootstrap(); err != nil {
		return err
	}
	if store.state.Base == nil {
		store.Changed() // a new database must reach the synced folder
	}
	migrations := func() int {
		var n int
		_ = app.DB().NewQuery("SELECT count(*) FROM _migrations").Row(&n)
		return n
	}
	before := migrations()

	var httpServer *http.Server
	stop := make(chan struct{}, 1)
	local := &localRoutes{p: p, store: store, key: key, stop: stop}
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.InstallerFunc = nil // accounts are created by `wikicontext init`
		httpServer = e.Server
		if migrations() != before {
			store.Changed()
		}
		local.register(e)
		return e.Next()
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		flush := time.NewTicker(5 * time.Second)
		heartbeat := time.NewTicker(30 * time.Second)
		defer flush.Stop()
		defer heartbeat.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-flush.C:
				if err := store.Flush(3 * time.Second); err != nil {
					log.Printf("write-back: %v", err)
				}
			case <-heartbeat.C:
				_ = writeLease(p)
			}
		}
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case <-signals:
		case <-stop:
		}
		if httpServer != nil {
			shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
			defer done()
			_ = httpServer.Shutdown(shutdown)
		}
	}()

	addr := fmt.Sprintf("127.0.0.1:%d", p.Config.Port)
	log.Printf("wikicontext %s serving %s at http://%s", Version, p.DB, addr)
	serveErr := apis.Serve(app, apis.ServeConfig{
		HttpAddr:       addr,
		AllowedOrigins: []string{p.URL(), fmt.Sprintf("http://localhost:%d", p.Config.Port)},
	})
	cancel()
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	closeErr := app.ResetBootstrapState()
	if err := store.Close(); err != nil {
		log.Printf("final write-back failed: %v", err)
		return err
	}
	if serveErr != nil {
		return serveErr
	}
	if closeErr != nil {
		log.Printf("closing databases: %v", closeErr)
	}
	log.Printf("stopped; %s is up to date", p.DB)
	return nil
}
