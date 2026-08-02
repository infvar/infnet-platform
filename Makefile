.PHONY: build build-control build-edge build-client test

build: build-control build-edge build-client

build-control:
	npm run build

build-edge:
	mkdir -p dist
	cd services/edge-agent && GOCACHE=$${GOCACHE:-$${PWD}/.gocache} CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ../../dist/infnet-edge-agent .

build-client:
	mkdir -p dist
	cd clients/infnet-client && GOCACHE=$${GOCACHE:-$${PWD}/.gocache} CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ../../dist/infnet-client .

test:
	npm --prefix apps/control-plane run build
	cd services/edge-agent && GOCACHE=$${GOCACHE:-$${PWD}/.gocache} go test -race ./... && go vet ./...
	cd clients/infnet-client && go test ./...
