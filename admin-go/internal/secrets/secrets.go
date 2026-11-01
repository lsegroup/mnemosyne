// Package secrets is the Go side of the data formats the Node server of Mnemosyne already writes and reads:
// the keys derived from the operator secret, the sealed files (provider keys, portal settings, members), the signed
// session cookies and the scrypt password hash of the built-in admin account. Everything here must stay byte-compatible
// with packages/server/src/secrets.ts, so the Go admin can take over the files and the sessions that exist today.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/scrypt"
)

// MinSecretLength is the shortest operator secret the portal accepts.
const MinSecretLength = 16

var b64 = base64.RawURLEncoding

// Keys are the two independent keys one operator secret yields.
type Keys struct {
	// Enc is the AES-256-GCM key for data at rest.
	Enc []byte
	// Sign is the HMAC-SHA256 key for session and OAuth-state cookies.
	Sign []byte
}

// DeriveKeys turns the operator secret into the encryption and signing keys (HKDF-SHA256, salt "mnemosyne-web").
func DeriveKeys(secret string) (Keys, error) {
	derive := func(info string) ([]byte, error) {
		return hkdf.Key(sha256.New, []byte(secret), []byte("mnemosyne-web"), info, 32)
	}
	enc, err := derive("enc")
	if err != nil {
		return Keys{}, err
	}
	sign, err := derive("sign")
	if err != nil {
		return Keys{}, err
	}
	return Keys{Enc: enc, Sign: sign}, nil
}

// ErrFormat is returned for data that is not in the sealed format at all.
var ErrFormat = errors.New("unsupported sealed format")

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts with AES-256-GCM: "v1.<iv>.<tag>.<ciphertext>", the parts base64url without padding.
func Seal(key []byte, plaintext string) (string, error) {
	aead, err := gcm(key)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	out := aead.Seal(nil, iv, []byte(plaintext), nil)
	ct, tag := out[:len(out)-aead.Overhead()], out[len(out)-aead.Overhead():]
	return strings.Join([]string{"v1", b64.EncodeToString(iv), b64.EncodeToString(tag), b64.EncodeToString(ct)}, "."), nil
}

// Open is the inverse of Seal. It fails on a wrong key or tampered data.
func Open(key []byte, sealed string) (string, error) {
	parts := strings.Split(sealed, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return "", ErrFormat
	}
	iv, err1 := b64.DecodeString(parts[1])
	tag, err2 := b64.DecodeString(parts[2])
	ct, err3 := b64.DecodeString(parts[3])
	if err := errors.Join(err1, err2, err3); err != nil {
		return "", ErrFormat
	}
	aead, err := gcm(key)
	if err != nil {
		return "", err
	}
	if len(iv) != aead.NonceSize() || len(tag) != aead.Overhead() {
		return "", ErrFormat
	}
	plain, err := aead.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", fmt.Errorf("sealed data does not open: %w", err)
	}
	return string(plain), nil
}

func mac(key []byte, body string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(body))
	return h.Sum(nil)
}

// SignToken returns "<base64url(json)>.<base64url(hmac)>". The payload must carry its own "exp" (epoch seconds).
func SignToken(key []byte, payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := b64.EncodeToString(raw)
	return body + "." + b64.EncodeToString(mac(key, body)), nil
}

// VerifyToken fills out with the payload and returns true, or returns false when the signature is wrong, the token
// is malformed or it has expired.
func VerifyToken(key []byte, token string, now time.Time, out any) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	sig, err := b64.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac(key, parts[0])) {
		return false
	}
	raw, err := b64.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var head struct {
		Exp *float64 `json:"exp"`
	}
	if json.Unmarshal(raw, &head) != nil || head.Exp == nil || *head.Exp <= float64(now.UnixMilli())/1000 {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}

// Session is the payload of the sign-in cookie, exactly as the Node server writes it.
type Session struct {
	U   string `json:"u"`           // GitLab username
	N   string `json:"n"`           // display name
	E   string `json:"e"`           // e-mail
	L   bool   `json:"l,omitempty"` // admin session from the built-in admin account
	Exp int64  `json:"exp"`         // epoch seconds
}

// scrypt parameters are Node's defaults (N=16384, r=8, p=1), 32-byte hash.
const (
	scryptN   = 1 << 14
	scryptR   = 8
	scryptP   = 1
	scryptLen = 32
)

// HashPassword returns "scrypt$<salt>$<hash>" (base64url) for the built-in admin password.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, scryptLen)
	if err != nil {
		return "", err
	}
	return "scrypt$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(hash), nil
}

// VerifyPassword is a constant-time check against HashPassword output; false for anything malformed.
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "scrypt" || parts[1] == "" || parts[2] == "" {
		return false
	}
	salt, err1 := b64.DecodeString(parts[1])
	want, err2 := b64.DecodeString(parts[2])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
