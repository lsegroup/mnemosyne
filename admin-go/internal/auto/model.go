package auto

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/lsegroup/mnemosyne/admin-go/internal/engine"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

// ModelKey is the one fingerprint of the model for TEXT (it also plans the charts) and everything that decides what a call can cost:
// the provider, the model, and the effective limits and prompts of the two jobs. An agreement is bound to it. When an image model paints the
// workflow diagram its provider and model are part of it (picture: provider id and model; both empty = no image model), so choosing or
// changing that model needs a new agreement; without one the key is what it always was.
func ModelKey(providerID, model string, text, image jobs.Effective, picture ...string) string {
	image.PicturePrompt = "" // what the image model is told for a picture changes no cost: editing it needs no new agreement
	parts := []any{providerID, model, text, image}
	if len(picture) == 2 && picture[1] != "" {
		parts = append(parts, picture)
	}
	sum := sha256.Sum256([]byte(engine.JSON(parts)))
	return hex.EncodeToString(sum[:])
}
