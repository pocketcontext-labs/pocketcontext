package bundle

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"ganigeorgiev.com/pocketbase/pocketbase/ui"
)

// listenerSet owns both listeners. One http.Server serves the same router and
// authentication hooks on both, and shutdown drains all accepted connections.
type listenerSet struct {
	mu      sync.Mutex
	p       *Project
	server  *http.Server
	socket  net.Listener
	tcp     net.Listener
	closing bool
	errors  chan error
}

func (s *listenerSet) enableTCP() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return errors.New("server is stopping")
	}
	if s.tcp != nil {
		return nil
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.p.Config.Port))
	if err != nil {
		return fmt.Errorf("reader port %d is unavailable; the headless server remains running: %w", s.p.Config.Port, err)
	}
	s.tcp = ln
	go func() { s.errors <- s.server.Serve(ln) }()
	return nil
}
func (s *listenerSet) state() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := ""
	if s.socket != nil {
		path = s.socket.Addr().String()
	}
	return path, s.tcp != nil
}

// serveHTTP preserves the app's migration and OnServe lifecycle without a
// vendored serving patch. TLS and the account installer are intentionally absent.
func serveHTTP(app core.App, p *Project, opts ServeOptions, stop <-chan struct{}, local *localRoutes) error {
	if err := app.RunAllMigrations(); err != nil {
		return err
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		return err
	}
	router.Bind(apis.CORS(apis.CORSConfig{
		AllowOrigins: []string{p.URL(), fmt.Sprintf("http://localhost:%d", p.Config.Port)},
		AllowMethods: []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodPost, http.MethodDelete},
	}))
	// Preserve the embedded dashboard route and its security/cache headers.
	if ui.DistDirFS != nil {
		router.GET("/_/{path...}", apis.Static(ui.DistDirFS, false)).BindFunc(func(e *core.RequestEvent) error {
			if !e.App.IsDev() && e.Request.PathValue(apis.StaticWildcardParam) != "" && e.Response.Header().Get("Cache-Control") == "" {
				e.Response.Header().Set("Cache-Control", "max-age=1209600, stale-while-revalidate=86400")
			}
			if e.Response.Header().Get("Content-Security-Policy") == "" {
				e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'")
			}
			return e.Next()
		}).Bind(apis.Gzip())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", p.Config.Port),
		ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, ReadHeaderTimeout: time.Minute,
		BaseContext: func(net.Listener) context.Context { return ctx },
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, socketContextKey{}, c.LocalAddr().Network() == "unix")
		},
	}
	listeners := &listenerSet{p: p, server: server, errors: make(chan error, 2)}
	local.listeners = listeners
	event := &core.ServeEvent{App: app, Router: router, Server: server}
	err = app.OnServe().Trigger(event, func(e *core.ServeEvent) error {
		handler, err := e.Router.BuildMux()
		if err != nil {
			return err
		}
		server = e.Server
		listeners.server = server
		server.Handler = handler
		return nil
	})
	if err != nil {
		return err
	}
	if server.Handler == nil {
		return errors.New("OnServe did not build the HTTP handler")
	}
	if !opts.TCPOnly {
		ln, err := listenSocket(p)
		if err != nil {
			return err
		}
		listeners.socket = ln
		defer ln.Close()
		go func() { listeners.errors <- server.Serve(ln) }()
	}
	if !opts.Headless || opts.TCPOnly || opts.UIDev != "" {
		if err := listeners.enableTCP(); err != nil {
			server.Close()
			return err
		}
	}
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error { cancel(); _ = server.Close(); return e.Next() })
	var serveErr error
	select {
	case <-stop:
	case serveErr = <-listeners.errors:
	}
	listeners.mu.Lock()
	listeners.closing = true
	listeners.mu.Unlock()
	cancel() // cancel SSE before waiting for graceful shutdown
	shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	if err := server.Shutdown(shutdown); err != nil {
		_ = server.Close()
		if serveErr == nil {
			serveErr = err
		}
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}
