package bundle

import (
	"context"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"github.com/pocketcontext-labs/pocketcontext/internal/chat"
	contextserver "github.com/pocketcontext-labs/pocketcontext/internal/pocketcontext/server"
)

// This fixture never contacts a provider or reads a real project.
func TestChatPhoneBrowser(t *testing.T) {
	if os.Getenv("POCKETCONTEXT_CHAT_BROWSER_TEST") != "1" {
		t.Skip("opt-in synthetic Playwright chat test")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	reader := filepath.Join(root, "ui", "dist")
	if _, err := os.Stat(filepath.Join(reader, "index.html")); err != nil {
		t.Fatal("build reader first:", err)
	}
	fake := filepath.Join(t.TempDir(), "fake-acp")
	compile := exec.Command("go", "test", "-c", "-o", fake, "./internal/chat")
	compile.Dir = root
	if out, err := compile.CombinedOutput(); err != nil {
		t.Fatalf("compile fake ACP: %v\n%s", err, out)
	}
	manager, err := chat.New(chat.Config{Command: fake, Args: []string{"-test.run=^TestACPProcess$"}, Env: append(os.Environ(), "CHAT_TEST_PROCESS=1", "CHAT_TEST_MODEL_EFFORT=1"), Dir: t.TempDir(), StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	a := newTestApp(t)
	spaces, err := a.app.FindCollectionByNameOrId("spaces")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Research notebook", "Field observations", "Design archive", "Reading list"} {
		record := core.NewRecord(spaces)
		record.Set("name", name)
		record.Set("revision", 1)
		if err := a.app.Save(record); err != nil {
			t.Fatal(err)
		}
	}
	contextserver.RegisterDatabase(a.app, filepath.Join(root, "server.json"), filepath.Join(a.app.DataDir(), "data.db"))
	t.Cleanup(func() {
		if err := a.app.OnTerminate().Trigger(&core.TerminateEvent{App: a.app}); err != nil {
			t.Error(err)
		}
	})
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	event := &core.ServeEvent{App: a.app, Router: router}
	server := httptest.NewUnstartedServer(nil)
	defer server.Close()
	_, portText, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	local := &localRoutes{p: &Project{Config: Config{Port: port}}}
	local.register(event)
	registerChat(event, manager)
	registerReader(event, reader)
	if err := a.app.OnServe().Trigger(event); err != nil {
		t.Fatal(err)
	}
	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = handler
	server.Start()
	code, _ := local.codes.issue(a.user.Id, 2*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "tests", "chat_reader_browser.mjs"))
	command.Env = append(os.Environ(), "POCKETCONTEXT_SYNTHETIC_CHAT_ORIGIN="+server.URL, "POCKETCONTEXT_SYNTHETIC_SIGNIN="+server.URL+"/bundle/login#"+code)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("chat phone browser: %v\n%s", err, output)
	}
	t.Log(string(output))
}
