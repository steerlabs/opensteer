package imagemounter

import "errors"

var ErrImageIncompatible = errors.New("developer image has no compatible identity")

type PersonalizationError struct{ Network bool }

func (e *PersonalizationError) Error() string { return "personalization failed" }

// Every attempted mounter must reject compatibility before another image is safe to try.
func IsImageIncompatible(err error) bool {
	if err == ErrImageIncompatible {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !IsImageIncompatible(cause) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return IsImageIncompatible(wrapped.Unwrap())
	}
	return false
}
