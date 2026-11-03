// SPDX-License-Identifier: Apache-2.0

package license

import (
	"crypto/ed25519"
	"encoding/base64"
)

// productionKey is the PUBLIC key of the licence server (base64 of the 32 raw bytes). The private half exists only on the licence
// server, so nothing built from this program can sign an answer. A build can replace it:
//
//	go build -ldflags "-X github.com/lsegroup/mnemosyne/admin-go/internal/license.productionKey=<base64>"
var productionKey = "ms9YAN0Vj2rNW/lFJbgusiEmQnHPKkosmRuBrgzOikE="

// ProductionKey is the key the licence server's answers are checked against.
func ProductionKey() ed25519.PublicKey {
	b, _ := base64.StdEncoding.DecodeString(productionKey)
	return ed25519.PublicKey(b)
}
