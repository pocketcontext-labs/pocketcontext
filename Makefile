# build-tags.txt lists the SQLite features and the tailscale.com features the tunnel omits.
TAGS := $(shell cat build-tags.txt)
VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/pocketcontext-labs/pocketcontext/internal/bundle.Version=$(VERSION)
GOBUILD := go build -trimpath -tags $(TAGS) -ldflags "$(LDFLAGS)"

.PHONY: ui dev build windows test names e2e
ui:
	cd ui && pnpm install --frozen-lockfile && pnpm build
dev:
	node scripts/dev.mjs --db "$(DB)"
build:
	CGO_ENABLED=1 $(GOBUILD) -o bin/pocketcontext ./cmd/pocketcontext
# Cross-compile from Linux or macOS with Zig as the C compiler (ZIG=/path/to/zig).
windows:
	CGO_ENABLED=1 GOOS=windows GOARCH=amd64 ZIG_TARGET=x86_64-windows-gnu CC="$(CURDIR)/scripts/zig-cc" \
		$(GOBUILD) -o bin/windows_amd64/pocketcontext.exe ./cmd/pocketcontext
test:
	CGO_ENABLED=1 go test -tags $(TAGS) ./...
	node --test tests/dev_launcher.test.mjs
# The repository and the binary must not contain the retired product name.
names: build
	python3 tests/name_check.py --binary bin/pocketcontext
e2e: names
	python3 tests/e2e.py --binary bin/pocketcontext
	python3 tests/source_search.py --binary bin/pocketcontext
