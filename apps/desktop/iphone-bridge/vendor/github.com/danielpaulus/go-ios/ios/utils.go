package ios

import (
	"encoding/binary"
	"fmt"
	"github.com/Masterminds/semver"
	plist "howett.net/plist"
)

const logModule = "go-ios"
const maxMessageSize = 1 << 24

func ToPlist(data interface{}) string {
	return string(ToPlistBytes(data))
}

// ParsePlist tries to parse the given bytes, which should be a Plist, into a map[string]interface.
// It returns the map or an error if the decoding step fails.
func ParsePlist(data []byte) (map[string]interface{}, error) {
	var result map[string]interface{}
	_, err := plist.Unmarshal(data, &result)
	return result, err
}

// ToPlistBytes converts a given struct to a Plist using the
// github.com/DHowett/go-plist library. Make sure your struct is exported.
// It returns a byte slice containing the plist.
func ToPlistBytes(data interface{}) []byte {
	bytes, err := plist.Marshal(data, plist.XMLFormat)
	if err != nil {
		// this should not happen
		panic(fmt.Sprintf("Failed converting to plist %v error:%v", data, err))
	}
	return bytes
}

func ToBinPlistBytes(data interface{}) []byte {
	bytes, err := plist.Marshal(data, plist.BinaryFormat)
	if err != nil {
		// this should not happen
		panic(fmt.Sprintf("Failed converting to plist %v error:%v", data, err))
	}
	return bytes
}

// Ntohs is a re-implementation of the C function Ntohs.
// it means networkorder to host oder and basically swaps
// the endianness of the given int.
// It returns port converted to little endian.
func Ntohs(port uint16) uint16 {
	buf := make([]byte, 2)
	binary.BigEndian.PutUint16(buf, port)
	return binary.LittleEndian.Uint16(buf)
}
func IOS26() *semver.Version {
	return semver.MustParse("26.0")
}
func IOS17() *semver.Version {
	return semver.MustParse("17.0")
}
func IOS16() *semver.Version {
	return semver.MustParse("16.0")
}
func IOS14() *semver.Version {
	return semver.MustParse("14.0")
}
func IOS12() *semver.Version {
	return semver.MustParse("12.0")
}
func IOS11() *semver.Version {
	return semver.MustParse("11.0")
}
