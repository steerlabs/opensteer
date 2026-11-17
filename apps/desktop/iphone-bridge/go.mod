module github.com/steerlabs/opensteer/iphone-bridge

go 1.26.0

replace github.com/danielpaulus/go-ios => ./third_party/go-ios

require (
	github.com/danielpaulus/go-ios v0.0.0-20261116112947-e5833ad1c5b6
	github.com/dchest/siphash v1.2.3
	github.com/google/uuid v1.1.2
	golang.org/x/image v0.39.0
	golang.org/x/net v0.55.0
	golang.org/x/sys v0.45.0
	gvisor.dev/gvisor v0.0.0-20240405191320-0878b34101b5
	howett.net/plist v1.0.1
)

require (
	github.com/Masterminds/semver v1.5.0 // indirect
	github.com/google/btree v1.1.2 // indirect
	github.com/tadglines/go-pkgs v0.0.0-20210623144937-b983b20f54f9 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	golang.org/x/time v0.5.0 // indirect
	google.golang.org/protobuf v1.32.0 // indirect
)
