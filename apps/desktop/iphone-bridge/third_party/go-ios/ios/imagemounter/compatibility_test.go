package imagemounter

import (
	"errors"
	"fmt"
	"testing"
)

func TestImageFallbackRequiresAllMountersToRejectCompatibility(t *testing.T) {
	missing := fmt.Errorf("identity lookup: %w", ErrImageIncompatible)
	if !IsImageIncompatible(errors.Join(missing, missing)) {
		t.Fatal("compatible-image fallback was blocked by wrapped identity refusals")
	}
	if IsImageIncompatible(errors.Join(missing, errors.New("mount outcome unknown"))) {
		t.Fatal("uncertain mount outcome allowed another image")
	}
	if _, err := (buildManifest{}).findIdentity(personalizationIdentifiers{BoardId: 1, ChipID: 2}); !IsImageIncompatible(err) {
		t.Fatal("missing hardware identity was not classified")
	}
	if _, err := (buildManifest{}).findCryptexIdentity(cryptexChip{}); !IsImageIncompatible(err) {
		t.Fatal("missing cryptex identity was not classified")
	}
}
