// Package store holds what the admin keeps on disk: the LLM providers with their keys and the model chosen per job, and the portal
// settings (GitLab SSO). Both are sealed files (AES-256-GCM, key derived from the operator secret) in exactly the format the Node server
// reads and writes, so the two can share them and nobody loses a setting when the admin moves to Go.
package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/secrets"
)

// sealedFile is a file holding one sealed JSON document. Writes are serialised (read-modify-write cycles cannot lose updates) and
// atomic (temporary file, then rename).
type sealedFile struct {
	path string
	key  []byte
	mu   sync.Mutex
}

// read returns the document, or nil when the file does not exist yet.
func (f *sealedFile) read() ([]byte, error) {
	raw, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := secrets.Open(f.key, strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, err
	}
	return []byte(plain), nil
}

func (f *sealedFile) write(doc []byte) error {
	if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return err
	}
	sealed, err := secrets.Seal(f.key, string(doc))
	if err != nil {
		return err
	}
	tmp := f.path + "." + itoa(os.Getpid()) + ".tmp"
	if err := os.WriteFile(tmp, []byte(sealed), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.path)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}
