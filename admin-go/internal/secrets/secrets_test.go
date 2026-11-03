package secrets

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// vectors is what the REAL Node implementation produced (testdata/gen/gen-vectors.mjs).
type vectors struct {
	Secret     string `json:"secret"`
	EncKeyHex  string `json:"encKeyHex"`
	SignKeyHex string `json:"signKeyHex"`
	Sealed     []struct {
		Plaintext string `json:"plaintext"`
		Sealed    string `json:"sealed"`
	} `json:"sealed"`
	Session struct {
		Payload Session `json:"payload"`
		Token   string  `json:"token"`
	} `json:"session"`
	Expired      string `json:"expired"`
	TamperedBody string `json:"tamperedBody"`
	NoExp        string `json:"noExp"`
	Password     struct {
		Plain string `json:"plain"`
		Hash  string `json:"hash"`
	} `json:"password"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "node-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestDeriveKeysMatchesNode(t *testing.T) {
	v := load(t)
	k, err := DeriveKeys(v.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(k.Enc) != v.EncKeyHex {
		t.Errorf("enc key %x, Node derived %s", k.Enc, v.EncKeyHex)
	}
	if hex.EncodeToString(k.Sign) != v.SignKeyHex {
		t.Errorf("sign key %x, Node derived %s", k.Sign, v.SignKeyHex)
	}
	if string(k.Enc) == string(k.Sign) {
		t.Error("the two keys must be independent")
	}
}

func TestOpensWhatNodeSealed(t *testing.T) {
	v := load(t)
	k, _ := DeriveKeys(v.Secret)
	for _, s := range v.Sealed {
		got, err := Open(k.Enc, s.Sealed)
		if err != nil || got != s.Plaintext {
			t.Errorf("Open(%q) = %q, %v", s.Plaintext, got, err)
		}
	}
}

func TestOpenRefusesWrongKeyTamperingAndForeignFormats(t *testing.T) {
	v := load(t)
	k, _ := DeriveKeys(v.Secret)
	other, _ := DeriveKeys("another-secret-with-enough-length")
	sealed := v.Sealed[2].Sealed
	if _, err := Open(other.Enc, sealed); err == nil {
		t.Error("opened with the wrong key")
	}
	parts := strings.Split(sealed, ".")
	parts[3] = "A" + parts[3][1:] // change the first character of the ciphertext
	if _, err := Open(k.Enc, strings.Join(parts, ".")); err == nil {
		t.Error("opened tampered data")
	}
	for _, bad := range []string{"", "plain text", "v2.a.b.c", "v1.a.b", "v1.!!.!!.!!", "v1.AAAA.AAAA.AAAA"} {
		if _, err := Open(k.Enc, bad); err == nil {
			t.Errorf("opened %q", bad)
		}
	}
}

func TestSealRoundTripFormatAndFreshIV(t *testing.T) {
	k, _ := DeriveKeys("a-test-secret-with-enough-length")
	a, err := Seal(k.Enc, "same text")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := Seal(k.Enc, "same text")
	if a == b {
		t.Error("two seals of the same text must differ (fresh IV)")
	}
	if p := strings.Split(a, "."); len(p) != 4 || p[0] != "v1" {
		t.Errorf("format %q", a)
	}
	if got, err := Open(k.Enc, a); err != nil || got != "same text" {
		t.Errorf("round trip: %q, %v", got, err)
	}
	if got, err := Open(k.Enc, mustSeal(t, k.Enc, "")); err != nil || got != "" {
		t.Errorf("empty text: %q, %v", got, err)
	}
}

func mustSeal(t *testing.T, key []byte, s string) string {
	t.Helper()
	out, err := Seal(key, s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestVerifiesTheTokensNodeSigned(t *testing.T) {
	v := load(t)
	k, _ := DeriveKeys(v.Secret)
	other, _ := DeriveKeys("another-secret-with-enough-length")
	now := time.Now()

	var s Session
	if !VerifyToken(k.Sign, v.Session.Token, now, &s) {
		t.Fatal("rejected the token Node signed")
	}
	if s != v.Session.Payload || s.U != "store" || s.N != "Example Admin" {
		t.Errorf("payload %+v", s)
	}
	var drop Session
	for name, token := range map[string]string{"expired": v.Expired, "tampered body": v.TamperedBody, "no exp": v.NoExp, "empty": "", "no dot": "abc", "three parts": v.Session.Token + ".x"} {
		if VerifyToken(k.Sign, token, now, &drop) {
			t.Errorf("accepted a token that is %s", name)
		}
	}
	if VerifyToken(other.Sign, v.Session.Token, now, &drop) {
		t.Error("accepted a token signed with another key")
	}
	if VerifyToken(k.Sign, v.Session.Token, time.Unix(v.Session.Payload.Exp, 0), &drop) {
		t.Error("accepted a token at the very second it expires")
	}
}

func TestTokensRoundTripAndExpire(t *testing.T) {
	k, _ := DeriveKeys("a-test-secret-with-enough-length")
	now := time.Now()
	token, err := SignToken(k.Sign, Session{U: "dev", N: "Some <Dev> & Co", E: "d@example.com", Exp: now.Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	var s Session
	if !VerifyToken(k.Sign, token, now, &s) || s.U != "dev" || s.N != "Some <Dev> & Co" {
		t.Fatalf("round trip failed: %+v", s)
	}
	if VerifyToken(k.Sign, token, now.Add(2*time.Hour), &s) {
		t.Error("accepted an expired token")
	}
}

func TestPasswordsMatchNode(t *testing.T) {
	v := load(t)
	if !VerifyPassword(v.Password.Plain, v.Password.Hash) {
		t.Error("rejected the password Node hashed")
	}
	if VerifyPassword("wrong", v.Password.Hash) {
		t.Error("accepted a wrong password")
	}
	for _, bad := range []string{"", "plain", "scrypt$", "scrypt$a$", "bcrypt$a$b", "scrypt$!$!"} {
		if VerifyPassword(v.Password.Plain, bad) {
			t.Errorf("accepted the malformed hash %q", bad)
		}
	}
	h, err := HashPassword("a new password")
	if err != nil {
		t.Fatal(err)
	}
	h2, _ := HashPassword("a new password")
	if h == h2 {
		t.Error("two hashes of the same password must differ (fresh salt)")
	}
	if !VerifyPassword("a new password", h) || VerifyPassword("a new password ", h) {
		t.Error("round trip failed")
	}
}

// The other direction, against the real Node code: skipped where Node or the Node build is not at hand.
func TestNodeAcceptsWhatGoWrites(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		dist = filepath.Join(root, "..", "packages", "server", "dist")
	}
	if _, err := os.Stat(filepath.Join(dist, "secrets.js")); err != nil {
		t.Skip("the Node build is not at hand (set MNEMOSYNE_NODE_DIST)")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}

	secret := "a-test-secret-with-enough-length"
	k, _ := DeriveKeys(secret)
	hash, _ := HashPassword("correct horse battery staple")
	token, _ := SignToken(k.Sign, Session{U: "store", N: "Example Admin", E: "store@example.com", L: true, Exp: 4102444800})
	expired, _ := SignToken(k.Sign, Session{U: "store", Exp: 946684800})
	out := map[string]any{
		"secret": secret, "encKeyHex": hex.EncodeToString(k.Enc), "signKeyHex": hex.EncodeToString(k.Sign),
		"sealed":  []map[string]string{},
		"session": Session{U: "store", N: "Example Admin", E: "store@example.com", L: true, Exp: 4102444800}, "token": token, "expired": expired,
		"password": map[string]string{"plain": "correct horse battery staple", "hash": hash},
	}
	var sealed []map[string]string
	for _, p := range []string{"hello", "", `{"dev":{"at":1}}`, "ümlauts, emoji 🧠 and \"quotes\""} {
		sealed = append(sealed, map[string]string{"plaintext": p, "sealed": mustSeal(t, k.Enc, p)})
	}
	out["sealed"] = sealed
	file := filepath.Join(t.TempDir(), "go-output.json")
	raw, _ := json.Marshal(out)
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, filepath.Join(root, "testdata", "gen", "verify-go.mjs"), file)
	cmd.Env = append(os.Environ(), "MNEMOSYNE_NODE_DIST="+dist)
	if res, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Node refused what Go wrote:\n%s", res)
	}
}
