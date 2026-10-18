package bundle

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

// Local routes replace Google sign-in. Reading the private key file proves the
// caller is this computer's user, who can already read the database file.
// Every other API still requires an ordinary users token.

const keyHeader = "X-WikiContext-Local-Key"

type localRoutes struct {
	p     *Project
	store *Store
	key   string
	stop  chan struct{}
	mu    sync.Mutex
	codes map[string]loginCode
}

type loginCode struct {
	user    string
	expires time.Time
}

func loopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (l *localRoutes) allowedHost(host string) bool {
	port := strings.TrimPrefix(l.p.URL(), "http://127.0.0.1")
	return host == "127.0.0.1"+port || host == "localhost"+port
}

func (l *localRoutes) requireKey(e *core.RequestEvent) error {
	given := e.Request.Header.Get(keyHeader)
	if !loopback(e.Request) || subtle.ConstantTimeCompare([]byte(given), []byte(l.key)) != 1 {
		return e.ForbiddenError("A local key is required.", nil)
	}
	return nil
}

// account returns the configured account, or the only enabled one.
func (l *localRoutes) account(app core.App) (*core.Record, error) {
	if l.p.Config.Email != "" {
		return app.FindAuthRecordByEmail("users", l.p.Config.Email)
	}
	records, err := app.FindRecordsByFilter("users", "disabled = false", "created", 2, 0)
	if err != nil {
		return nil, err
	}
	if len(records) != 1 {
		return nil, apis.NewBadRequestError("Set the account email in wikicontext.json.", nil)
	}
	return records[0], nil
}

func (l *localRoutes) register(e *core.ServeEvent) {
	// DNS rebinding protection: a web page cannot reach this server under another name.
	e.Router.Bind(&hook.Handler[*core.RequestEvent]{
		Id: "wikicontextLocalHost", Priority: -99999,
		Func: func(re *core.RequestEvent) error {
			if !l.allowedHost(re.Request.Host) {
				return re.ForbiddenError("Unexpected host.", nil)
			}
			return re.Next()
		},
	})

	e.Router.GET("/api/bundle/instance", func(re *core.RequestEvent) error {
		return re.JSON(http.StatusOK, map[string]string{
			"app": "wikicontext", "version": Version, "instance": l.p.Config.Instance, "key": l.p.Key,
		})
	})

	e.Router.POST("/api/bundle/token", func(re *core.RequestEvent) error {
		if err := l.requireKey(re); err != nil {
			return err
		}
		user, err := l.account(re.App)
		if err != nil {
			return re.BadRequestError("No local account; run `wikicontext init`.", nil)
		}
		return apis.RecordAuthResponse(re, user, "local", nil)
	})

	e.Router.POST("/api/bundle/account", func(re *core.RequestEvent) error {
		if err := l.requireKey(re); err != nil {
			return err
		}
		var body struct {
			Email    string `json:"email"`
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if err := re.BindBody(&body); err != nil {
			return re.BadRequestError("Invalid account.", nil)
		}
		if len(body.Password) < 8 {
			return re.BadRequestError("The password needs at least 8 characters.", nil)
		}
		user, err := re.App.FindAuthRecordByEmail("users", body.Email)
		created := err != nil
		if created {
			users, err := re.App.FindCollectionByNameOrId("users")
			if err != nil {
				return err
			}
			user = core.NewRecord(users)
			user.SetEmail(body.Email)
			user.SetVerified(true)
			name := strings.TrimSpace(body.Name)
			if name == "" {
				name = strings.Split(body.Email, "@")[0]
			}
			user.Set("name", name)
		}
		user.SetPassword(body.Password)
		if err := re.App.Save(user); err != nil {
			return re.BadRequestError("Could not save the account: "+err.Error(), nil)
		}
		return re.JSON(http.StatusOK, map[string]any{"id": user.Id, "email": user.Email(), "created": created})
	})

	e.Router.POST("/api/bundle/login-code", func(re *core.RequestEvent) error {
		if err := l.requireKey(re); err != nil {
			return err
		}
		user, err := l.account(re.App)
		if err != nil {
			return re.BadRequestError("No local account; run `wikicontext init`.", nil)
		}
		code := RandomHex(24)
		l.mu.Lock()
		if l.codes == nil {
			l.codes = map[string]loginCode{}
		}
		for c, v := range l.codes {
			if time.Now().After(v.expires) {
				delete(l.codes, c)
			}
		}
		l.codes[code] = loginCode{user.Id, time.Now().Add(2 * time.Minute)}
		l.mu.Unlock()
		return re.JSON(http.StatusOK, map[string]string{"url": l.p.URL() + "/bundle/login#" + code})
	})

	e.Router.POST("/api/bundle/redeem", func(re *core.RequestEvent) error {
		var body struct {
			Code string `json:"code"`
		}
		if err := re.BindBody(&body); err != nil {
			return re.BadRequestError("Invalid code.", nil)
		}
		l.mu.Lock()
		code, ok := l.codes[body.Code]
		delete(l.codes, body.Code) // single use
		l.mu.Unlock()
		if !ok || time.Now().After(code.expires) {
			return re.UnauthorizedError("This sign-in link is used or expired; run `wikicontext open` again.", nil)
		}
		user, err := re.App.FindRecordById("users", code.user)
		if err != nil {
			return re.UnauthorizedError("Account not found.", nil)
		}
		return apis.RecordAuthResponse(re, user, "local", nil)
	})

	e.Router.POST("/api/bundle/flush", func(re *core.RequestEvent) error {
		if err := l.requireKey(re); err != nil {
			return err
		}
		l.store.mu.Lock()
		err := l.store.writeBack()
		l.store.mu.Unlock()
		if err != nil {
			return re.InternalServerError("Write-back failed: "+err.Error(), nil)
		}
		return re.JSON(http.StatusOK, map[string]string{"db": l.p.DB})
	})

	e.Router.POST("/api/bundle/stop", func(re *core.RequestEvent) error {
		if err := l.requireKey(re); err != nil {
			return err
		}
		select {
		case l.stop <- struct{}{}:
		default:
		}
		return re.JSON(http.StatusOK, map[string]bool{"stopping": true})
	})

	page := func(re *core.RequestEvent, contentType, body string) error {
		h := re.Response.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		return re.Blob(http.StatusOK, contentType, []byte(body))
	}
	e.Router.GET("/bundle/login", func(re *core.RequestEvent) error {
		return page(re, "text/html; charset=utf-8", loginHTML)
	})
	e.Router.GET("/bundle/login.js", func(re *core.RequestEvent) error {
		return page(re, "text/javascript; charset=utf-8", loginJS)
	})
}

const loginHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WikiContext sign-in</title></head>
<body><p id="status">Signing in…</p><script src="/bundle/login.js"></script></body></html>`

// The code travels in the fragment, so it never reaches logs or the Referer.
const loginJS = `(async () => {
  const status = document.getElementById("status");
  const code = location.hash.slice(1);
  history.replaceState(null, "", "/bundle/login");
  try {
    const response = await fetch("/api/bundle/redeem", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Sign-in failed.");
    localStorage.setItem("wikicontext.reader.auth", JSON.stringify({token: data.token, record: data.record}));
    location.replace("/");
  } catch (error) {
    status.textContent = error.message + " Run wikicontext open again, or sign in with your password.";
  }
})();`
