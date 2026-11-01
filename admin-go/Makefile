# Build and test the Go admin.  `make build` makes one static binary: no Go, no Node modules and no other files are needed next to it.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build test vet assets
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/mnemosyne-admin ./cmd/mnemosyne-admin

vet:
	gofmt -l . | (! grep .) && go vet ./...

# The tests that need the Node build (../packages/server/dist, or MNEMOSYNE_NODE_DIST) skip themselves when it is not there.
test: vet
	go test ./... -count=1

# After a change of the AI job definitions, the version or the fonts in the Node repository: write that data again from the Node build
# (the admin page and the sign-in page are this program's own files in internal/assets).
assets:
	node tools/extract-assets.mjs
