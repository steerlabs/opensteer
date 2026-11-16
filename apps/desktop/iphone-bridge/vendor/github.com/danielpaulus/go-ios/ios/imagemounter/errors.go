package imagemounter

type PersonalizationError struct{ Network bool }

func (e *PersonalizationError) Error() string { return "personalization failed" }
