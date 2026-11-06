package bundle

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/acme/autocert"
	"golang.org/x/time/rate"
)

// ValidateHTTPSDomain accepts one explicit ASCII DNS name, never a wildcard,
// URL or address. IDNs can be supplied in their ASCII (punycode) form.
func ValidateHTTPSDomain(domain string) error {
	if len(domain) > 253 || !strings.Contains(domain, ".") || net.ParseIP(domain) != nil || domain != strings.ToLower(domain) {
		return errors.New("domain must be a lowercase DNS name, without a scheme, port, path or wildcard")
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return errors.New("domain contains an invalid DNS label")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return errors.New("domain must use ASCII DNS labels; use punycode for international names")
			}
		}
	}
	return nil
}

type publicContextKey struct{}

func publicRequest(r *http.Request) bool {
	v, _ := r.Context().Value(publicContextKey{}).(bool)
	return v
}

var publicCollections = []string{"spaces", "settings", "sources", "renditions", "passages", "pages", "ingestion_runs", "page_revisions", "citations", "page_links", "publications", "audit_log"}

// publicRoute is deliberately an allowlist. A future local API does not become
// public merely because it was registered on the application's router.
func publicRoute(method, p string, collections map[string]bool, sources map[string]bool) bool {
	read := method == http.MethodGet || method == http.MethodHead
	if read && (p == "/" || p == "/api/bundle/auth-mode" || p == "/bundle/login" || p == "/bundle/login.js") {
		return true
	}
	if read && strings.HasPrefix(p, "/assets/") && readerAssetName.MatchString(strings.TrimPrefix(p, "/assets/")) {
		return true
	}
	if read && (p == "/api/context/schema" || p == "/api/spaces/default" || p == "/api/realtime") {
		return true
	}
	if method == http.MethodPost {
		switch p {
		case "/api/bundle/redeem", "/api/collections/users/auth-with-password", "/api/collections/users/auth-refresh", "/api/context/query", "/api/context/search", "/api/realtime", "/api/files/token":
			return true
		}
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	if len(parts) == 5 && parts[0] == "api" && parts[1] == "pocketcontext" && parts[2] == "runs" && parts[4] == "check" {
		return read
	}
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "collections" && collections[parts[2]] && parts[3] == "records" {
		if len(parts) == 4 {
			return read || method == http.MethodPost
		}
		if len(parts) == 5 && parts[4] != "" {
			return read || method == http.MethodPatch
		}
	}
	return read && len(parts) == 5 && parts[0] == "api" && parts[1] == "files" && sources[parts[2]] && parts[3] != "" && parts[4] != ""
}

type authAttempt struct {
	limiter *rate.Limiter
	touched time.Time
}
type publicAuthLimiter struct {
	mu      sync.Mutex
	entries map[string]authAttempt
}

func (l *publicAuthLimiter) allow(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = make(map[string]authAttempt)
	}
	entry, ok := l.entries[host]
	if !ok {
		if len(l.entries) >= 4096 {
			for k, v := range l.entries {
				if now.Sub(v.touched) > 10*time.Minute {
					delete(l.entries, k)
				}
			}
			if len(l.entries) >= 4096 {
				return false
			}
		}
		entry.limiter = rate.NewLimiter(rate.Every(6*time.Second), 10)
	}
	entry.touched = now
	l.entries[host] = entry
	return entry.limiter.Allow()
}

func publicHandler(app core.App, domain string, next http.Handler, oauth ...*mcpOAuth) http.Handler {
	return publicHandlerMode(app, domain, next, false, oauth...)
}

func publicHandlerMode(app core.App, domain string, next http.Handler, hosted bool, oauth ...*mcpOAuth) http.Handler {
	var mcp *mcpOAuth
	if len(oauth) > 0 {
		mcp = oauth[0]
	}
	collections := map[string]bool{}
	sources := map[string]bool{"sources": true}
	for _, name := range publicCollections {
		collections[name] = true
		if c, err := app.FindCollectionByNameOrId(name); err == nil {
			collections[c.Id] = true
			if name == "sources" {
				sources[c.Id] = true
			}
		}
	}
	limiter := &publicAuthLimiter{}
	emailLimiter := rate.NewLimiter(rate.Every(6*time.Second), 10)
	redemptionLimiter := rate.NewLimiter(rate.Every(6*time.Second), 10)
	var otpMu sync.Mutex // Serialize OTP redemption, including validation and deletion.

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hosted && r.URL.Path == "/up" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Host != domain && r.Host != domain+":443" {
			http.Error(w, "Unexpected host.", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+domain {
			http.Error(w, "Unexpected origin.", http.StatusForbidden)
			return
		}
		// Refuse escaped separators and dot paths rather than relying on downstream
		// router canonicalization to agree with this security boundary.
		escaped := strings.ToLower(r.URL.EscapedPath())
		if r.URL.Path != path.Clean(r.URL.Path) || strings.Contains(r.URL.Path, "\\") || strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") {
			http.NotFound(w, r)
			return
		}
		isOAuth := mcp != nil && oauthRoute(r.Method, r.URL.Path)
		isOTP := hosted && r.Method == http.MethodPost && (r.URL.Path == "/api/collections/users/request-otp" || r.URL.Path == "/api/collections/users/auth-with-otp")
		if hosted && (r.URL.Path == "/api/collections/users/auth-with-password" || r.URL.Path == "/api/bundle/redeem" || strings.HasPrefix(r.URL.Path, "/bundle/login")) {
			http.NotFound(w, r)
			return
		}
		if !isOAuth && !isOTP && !publicRoute(r.Method, r.URL.Path, collections, sources) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if isOTP {
			w.Header().Set("Cache-Control", "no-store")
			selectedLimiter := emailLimiter
			limitName := "email_request"
			if r.URL.Path == "/api/collections/users/auth-with-otp" {
				selectedLimiter = redemptionLimiter
				limitName = "email_redemption"
			}
			if !selectedLimiter.Allow() {
				writeRateLimit(app, w, r, rateLimitInfo{limitName, 6, 10, 0, 60}, "Too many requests. Please try again shortly.")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
			if r.URL.Path == "/api/collections/users/auth-with-otp" {
				otpMu.Lock()
				defer otpMu.Unlock()
			}
		} else if r.URL.Path == "/api/bundle/redeem" || r.URL.Path == "/api/collections/users/auth-with-password" {
			w.Header().Set("Cache-Control", "no-store")
			if !limiter.allow(r.RemoteAddr) {
				writeRateLimit(app, w, r, limiter.rejection(r.RemoteAddr, "public_auth"), "Too many sign-in attempts. Try again shortly.")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		} else {
			r.Body = http.MaxBytesReader(w, r.Body, 110<<20)
		}
		// Native serving terminates TLS itself; hosted mode has a fixed HTTPS
		// origin at its upstream proxy. Forwarded headers are never authority
		// for identity, origin, scheme, or source-address decisions.
		for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", keyHeader} {
			r.Header.Del(name)
		}
		r = r.WithContext(context.WithValue(r.Context(), publicContextKey{}, true))
		if isOAuth {
			mcp.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// publicHTTPHandler never passes plaintext traffic to the application. The
// configured hostname is checked before both ACME and canonical redirects.
func publicHTTPHandler(domain string, challenge func(http.Handler) http.Handler) http.Handler {
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Use HTTPS.", http.StatusBadRequest)
			return
		}
		http.Redirect(w, r, "https://"+domain+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
	handler := challenge(redirect)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != domain && r.Host != domain+":80" {
			http.Error(w, "Unexpected host.", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
}

type publicServers struct {
	https, http                *http.Server
	tlsListener, plainListener net.Listener
}

func (s *publicServers) close() {
	if s.https != nil {
		_ = s.https.Close()
	}
	if s.http != nil {
		_ = s.http.Close()
	}
	if s.tlsListener != nil {
		_ = s.tlsListener.Close()
	}
	if s.plainListener != nil {
		_ = s.plainListener.Close()
	}
}
func (s *publicServers) shutdown(ctx context.Context) error {
	var errs []error
	if s.http != nil {
		errs = append(errs, s.http.Shutdown(ctx))
	}
	if s.https != nil {
		errs = append(errs, s.https.Shutdown(ctx))
	}
	return errors.Join(errs...)
}

func publicCertificateManager(p *Project, opts ServeOptions) (*autocert.Manager, *tls.Config, error) {
	cache := filepath.Join(p.Cache, "acme")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(cache, 0700); err != nil {
		return nil, nil, err
	}
	manager := &autocert.Manager{Prompt: autocert.AcceptTOS, Cache: autocert.DirCache(cache), HostPolicy: autocert.HostWhitelist(opts.HTTPSDomain), Email: opts.ACMEEmail}
	tlsConfig := manager.TLSConfig()
	tlsConfig.MinVersion = tls.VersionTLS12
	// HostPolicy only applies to uncached certificates; reject unknown SNI even
	// when a previous domain's certificate remains in the persistent cache.
	getCertificate := tlsConfig.GetCertificate
	tlsConfig.GetCertificate = func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if hello.ServerName != opts.HTTPSDomain {
			return nil, errors.New("unconfigured TLS hostname")
		}
		return getCertificate(hello)
	}
	return manager, tlsConfig, nil
}

func startPublicHTTPS(ctx context.Context, app core.App, p *Project, opts ServeOptions, handler http.Handler, failures chan<- error) (*publicServers, error) {
	manager, tlsConfig, err := publicCertificateManager(p, opts)
	if err != nil {
		return nil, err
	}
	var oauth *mcpOAuth
	if opts.MCP {
		if opts.MCPHandler == nil {
			return nil, errors.New("MCP protocol adapter unavailable")
		}
		oauth, err = newMCPOAuth(app, p, opts.HTTPSDomain, opts.MCPHandler(handler))
		if err != nil {
			return nil, err
		}
	}
	return startPublicListeners(ctx, publicHandler(app, opts.HTTPSDomain, handler, oauth), publicHTTPHandler(opts.HTTPSDomain, manager.HTTPHandler), tlsConfig, ":443", ":80", failures)
}

// Addresses are internal parameters so lifecycle tests can use ephemeral ports.
// The public CLI always binds the standard HTTPS and HTTP ports.
func startPublicListeners(ctx context.Context, handler, plainHandler http.Handler, tlsConfig *tls.Config, tlsAddress, plainAddress string, failures chan<- error) (*publicServers, error) {
	tlsListener, err := net.Listen("tcp", tlsAddress)
	if err != nil {
		return nil, fmt.Errorf("listen on HTTPS port 443 (check permissions and existing services): %w", err)
	}
	plainListener, err := net.Listen("tcp", plainAddress)
	if err != nil {
		_ = tlsListener.Close()
		return nil, fmt.Errorf("listen on HTTP port 80 (check permissions and existing services): %w", err)
	}
	s := &publicServers{tlsListener: tlsListener, plainListener: plainListener}
	s.https = &http.Server{Handler: handler, TLSConfig: tlsConfig, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	s.http = &http.Server{Handler: plainHandler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { failures <- s.https.ServeTLS(tlsListener, "", "") }()
	go func() { failures <- s.http.Serve(plainListener) }()
	return s, nil
}
