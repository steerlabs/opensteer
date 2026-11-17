package amfi

import (
	"fmt"

	"github.com/danielpaulus/go-ios/ios"
)

const serviceName string = "com.apple.amfi.lockdown"

const logModule = "go-ios/amfi"

type Connection struct {
	deviceConn ios.DeviceConnectionInterface
	plistCodec ios.PlistCodec
}

func New(device ios.DeviceEntry) (*Connection, error) {
	deviceConn, err := ios.ConnectToService(device, serviceName)
	if err != nil {
		return &Connection{}, err
	}

	var devModeConn Connection
	devModeConn.deviceConn = deviceConn
	devModeConn.plistCodec = ios.NewPlistCodec()

	return &devModeConn, nil
}

func (devModeConn *Connection) Close() error {
	return devModeConn.deviceConn.Close()
}

// RevealDevMode sends action 0 to the AMFI service, which makes the
// Developer Mode toggle visible in Settings → Privacy & Security.
// This replicates what Xcode does when it detects Developer Mode is disabled.
func (devModeConn *Connection) RevealDevMode() error {
	reader := devModeConn.deviceConn.Reader()

	request := map[string]interface{}{"action": 0}

	bytes, err := devModeConn.plistCodec.Encode(request)
	if err != nil {
		return fmt.Errorf("RevealDevMode: failed encoding request to service with err: %w", err)
	}

	err = devModeConn.deviceConn.Send(bytes)
	if err != nil {
		return fmt.Errorf("RevealDevMode: failed sending request bytes to service with err: %w", err)
	}

	responseBytes, err := devModeConn.plistCodec.Decode(reader)
	if err != nil {
		return fmt.Errorf("RevealDevMode: failed decoding response from service with err: %w", err)
	}

	plist, err := ios.ParsePlist(responseBytes)
	if err != nil {
		return fmt.Errorf("RevealDevMode: failed parsing response plist with err: %w", err)
	}

	if errorMsg, ok := plist["Error"]; ok {
		return fmt.Errorf("RevealDevMode: could not reveal developer mode menu: %s", errorMsg)
	}

	if success, ok := plist["success"].(bool); ok && success {
		return nil
	}

	return fmt.Errorf("RevealDevMode: no error or success was reported")
}
