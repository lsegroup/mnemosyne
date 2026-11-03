#!/usr/bin/env bash
# Builds release/mnemosyne_<version>.zip: the server, the admin program for linux/amd64 and linux/arm64, install.sh and the docs.
#   deploy/make-release.sh            (version = package.json)
# Needs: node/npm, go, zip. The zip is made from the working tree, so run it on the commit that is to be released.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
NAME="mnemosyne_${VERSION}"
OUT="$ROOT/release"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/$NAME"
mkdir -p "$D/bin" "$D/server/packages" "$D/docs"

echo "==> building the server"
npm ci --no-audit --no-fund --loglevel=error
npm run build >/dev/null

echo "==> building the admin program ($VERSION, linux/amd64 and linux/arm64)"
for arch in amd64 arm64; do
  ( cd admin-go && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$D/bin/mnemosyne-admin-linux-$arch" ./cmd/mnemosyne-admin )
done
( cd "$D/bin" && sha256sum mnemosyne-admin-linux-* > SHA256SUMS )

echo "==> assembling"
cp package.json package-lock.json "$D/server/"
for p in core server vscode-extension; do
  mkdir -p "$D/server/packages/$p"
  cp "packages/$p/package.json" "$D/server/packages/$p/"
done
cp -a packages/core/dist "$D/server/packages/core/dist"
cp -a packages/server/dist "$D/server/packages/server/dist"
# source maps and type declarations are not needed to run
find "$D/server" \( -name '*.map' -o -name '*.d.ts' \) -delete
cp deploy/release/install.sh "$D/install.sh"
cp deploy/release/README.txt "$D/README.txt"
cp LICENSE NOTICE CHANGELOG.md "$D/"
cp docs/self-hosting.md docs/architecture.md "$D/docs/"
cp .env.example "$D/env.example"
echo "$VERSION" > "$D/VERSION"
chmod +x "$D/install.sh"

echo "==> zipping"
mkdir -p "$OUT"
rm -f "$OUT/$NAME.zip"
# fixed time stamps and a fixed order: the same tree gives the same zip
find "$D" -exec touch -d '2026-01-01 00:00:00' {} +
( cd "$STAGE" && find "$NAME" | LC_ALL=C sort | zip -X -q "$OUT/$NAME.zip" -@ )
( cd "$OUT" && sha256sum mnemosyne_*.zip > SHA256SUMS )
echo "✓ release/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
cat "$OUT/SHA256SUMS"
