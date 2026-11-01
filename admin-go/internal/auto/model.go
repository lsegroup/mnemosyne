package auto

import (
	"crypto/sha256"
	"encoding/hex"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/engine"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
)

// ModelKey is the one fingerprint of the model for TEXT (it also plans the charts) and everything that decides what a call can cost:
// the provider, the model, and the effective limits and prompts of the two jobs. An agreement is bound to it.
func ModelKey(providerID, model string, text, image jobs.Effective) string {
	sum := sha256.Sum256([]byte(engine.JSON([]any{providerID, model, text, image})))
	return hex.EncodeToString(sum[:])
}
