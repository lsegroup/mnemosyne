// SPDX-License-Identifier: Apache-2.0

// Package golden keeps the answers of the old Node implementation that the Go tests compare with. The Node repository no longer
// contains the admin and the Auto scheduler (they are Go now), so what that Node code answered is recorded once, from the last Node
// build that still had them, and kept in testdata/golden. To record again (only when the Go behaviour is changed on purpose):
//
//	RECORD_GOLDEN=1 MNEMOSYNE_NODE_DIST=<a Node build that still has the code> go test ./...
package golden

import (
	"os"
	"path/filepath"
	"testing"
)

// Bytes returns the recorded answer called name; in record mode it makes the answer with record and keeps it.
func Bytes(t testing.TB, name string, record func() []byte) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "golden", name)
	if os.Getenv("RECORD_GOLDEN") == "1" {
		out := record()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, out, 0o644); err != nil {
			t.Fatal(err)
		}
		return out
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the recorded Node answer %s is missing (%v); record it with RECORD_GOLDEN=1 from a Node build that has the code", name, err)
	}
	return b
}
