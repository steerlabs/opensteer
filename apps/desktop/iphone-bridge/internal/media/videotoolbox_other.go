//go:build !darwin || !cgo

package media

func nativeCodecs() (codecFactory, error) {
	return codecFactory{}, ErrVideoToolboxUnavailable
}
