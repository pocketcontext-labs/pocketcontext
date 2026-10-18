TAGS := sqlite_math_functions,sqlite_percentile,sqlite_fts5
VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/pocketcontext/wikicontext-bundle/internal/bundle.Version=$(VERSION)
GOBUILD := go build -trimpath -tags $(TAGS) -ldflags "$(LDFLAGS)"

.PHONY: ui build windows test e2e
ui:
	cd ui && pnpm install --frozen-lockfile && pnpm build
build:
	CGO_ENABLED=1 $(GOBUILD) -o bin/wikicontext ./cmd/wikicontext
# Cross-compile from Linux or macOS with Zig as the C compiler (ZIG=/path/to/zig).
windows:
	CGO_ENABLED=1 GOOS=windows GOARCH=amd64 ZIG_TARGET=x86_64-windows-gnu CC="$(CURDIR)/scripts/zig-cc" \
		$(GOBUILD) -o bin/windows_amd64/wikicontext.exe ./cmd/wikicontext
test:
	CGO_ENABLED=1 go test -tags $(TAGS) ./...
e2e: build
	python3 tests/e2e.py --binary bin/wikicontext
