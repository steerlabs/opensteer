package ios

import (
	"fmt"
	"io"
	"net"

	"github.com/danielpaulus/go-ios/ios/http"

	"github.com/danielpaulus/go-ios/ios/xpc"
)

type connectMessage struct {
	BundleID            string
	ClientVersionString string
	MessageType         string
	ProgName            string
	LibUSBMuxVersion    uint32 `plist:"kLibUSBMuxVersion"`
	DeviceID            uint32
	PortNumber          uint16
}

func newConnectMessage(deviceID int, portNumber uint16) connectMessage {
	data := connectMessage{
		BundleID:            "go.ios.control",
		ClientVersionString: "go-usbmux-0.0.1",
		MessageType:         "Connect",
		ProgName:            "go-usbmux",
		LibUSBMuxVersion:    3,
		DeviceID:            uint32(deviceID),
		PortNumber:          portNumber,
	}
	return data
}

// Connect issues a Connect Message to UsbMuxd for the given deviceID on the given port
// enabling the newCodec for it.
// It returns an error containing the UsbMux error code should the connect fail.
func (muxConn *UsbMuxConnection) Connect(deviceID int, port uint16) error {
	msg := newConnectMessage(deviceID, Ntohs(port))
	muxConn.Send(msg)
	resp, err := muxConn.ReadMessage()
	if err != nil {
		return err
	}
	response := MuxResponsefromBytes(resp.Payload)
	if response.IsSuccessFull() {
		return nil
	}
	return fmt.Errorf("Failed connecting to service, error code:%d", response.Number)
}

// serviceConfigurations stores info about which DTX based services only execute a SSL Handshake
// and then go back to sending unencrypted data right after the handshake.
var serviceConfigurations = map[string]bool{
	"com.apple.instruments.remoteserver":                 true,
	"com.apple.accessibility.axAuditDaemon.remoteserver": true,
	"com.apple.testmanagerd.lockdown":                    true,
	"com.apple.debugserver":                              true,
}

// ConnectLockdown connects this Usbmux connection to the LockDown service that
// always runs on the device on the same port. The connect call needs the deviceID which can be
// retrieved from a DeviceList using the ListDevices function. After this function
// is done, the UsbMuxConnection cannot be used anymore because the same underlying
// network connection is used for talking to Lockdown. Sending usbmux commands would break it.
// It returns a new LockDownConnection.
func (muxConn *UsbMuxConnection) ConnectLockdown(deviceID int) (*LockDownConnection, error) {
	msg := newConnectMessage(deviceID, Lockdownport)
	err := muxConn.Send(msg)
	if err != nil {
		return &LockDownConnection{}, err
	}
	resp, err := muxConn.ReadMessage()
	if err != nil {
		return &LockDownConnection{}, err
	}
	response := MuxResponsefromBytes(resp.Payload)
	if response.IsSuccessFull() {
		return &LockDownConnection{muxConn.deviceConn, "", NewPlistCodec()}, nil
	}

	return nil, fmt.Errorf("Failed connecting to Lockdown with error code:%d", response.Number)
}

func ConnectToService(device DeviceEntry, serviceName string) (DeviceConnectionInterface, error) {
	startServiceResponse, err := StartService(device, serviceName)
	if err != nil {
		return nil, err
	}
	pairRecord, err := ReadPairRecordContext(device.ContextOrBackground(), device.Properties.SerialNumber)
	if err != nil {
		return nil, err
	}

	muxConn, err := NewUsbMuxConnectionContext(device.ContextOrBackground())
	if err != nil {
		return nil, fmt.Errorf("Could not connect to usbmuxd socket, is it running? %w", err)
	}
	err = muxConn.connectWithStartServiceResponse(device.DeviceID, startServiceResponse, pairRecord)
	if err != nil {
		_ = muxConn.Close()
		return nil, err
	}
	return muxConn.ReleaseDeviceConnection(), nil
}

// RsdPortForService looks up the port a service is listening on in the given RSD service list.
// Services provided by the developer disk image only show up after a recent enough image has been
// mounted: mounting adds them, but an outdated image can lack newer services even when mounted.
// Without this check we would dial port 0 and report a confusing 'connection refused' instead of
// the actual cause.
func RsdPortForService(rsd RsdPortProvider, service string) (int, error) {
	port := rsd.GetPort(service)
	if port == 0 {
		return 0, fmt.Errorf("service '%s' is not available in RSD. If it is provided by the developer disk image, make sure a recent image is mounted (run `ios image auto`) — an outdated image can lack this service even when mounted", service)
	}
	return port, nil
}

// ConnectToShimService opens a new connection of the tunnel interface of the provided device
// to the provided service.
// The 'RSDCheckin' required by shim services is also executed before returning the connection to the caller
func ConnectToShimService(device DeviceEntry, service string) (DeviceConnectionInterface, error) {
	if !device.SupportsRsd() {
		return nil, fmt.Errorf("ConnectToShimService: Cannot connect to %s, missing tunnel address and RSD port.  To start the tunnel, run `ios tunnel start`", service)
	}
	port, err := RsdPortForService(device.Rsd, service)
	if err != nil {
		return nil, fmt.Errorf("ConnectToShimService: %w", err)
	}
	conn, err := ConnectTUNDevice(device.Address, port, device)
	if err != nil {
		return nil, err
	}
	wrapped := NewDeviceConnectionWithConn(conn)
	wrapped.BindContext(device.ContextOrBackground())
	err = RsdCheckin(wrapped)
	if err != nil {
		_ = wrapped.Close()
		return nil, err
	}
	return wrapped, nil
}

// ConnectToServiceTunnelIface connects to a service on an iOS17+ device using a XPC over HTTP2 connection
// It returns a new xpc.Connection
func ConnectToXpcServiceTunnelIface(device DeviceEntry, serviceName string) (*xpc.Connection, error) {
	if !device.SupportsRsd() {
		return nil, fmt.Errorf("ConnectToXpcServiceTunnelIface: Cannot connect to %s, missing tunnel address and RSD port. To start the tunnel, run `ios tunnel start`", serviceName)
	}
	port, err := RsdPortForService(device.Rsd, serviceName)
	if err != nil {
		return nil, fmt.Errorf("ConnectToXpcServiceTunnelIface: %w", err)
	}

	conn, err := ConnectTUNDevice(device.Address, port, device)
	if err != nil {
		return nil, fmt.Errorf("ConnectToHttp2: failed to dial: %w", err)
	}

	defer func() {
		if err != nil {
			_ = conn.Close()
		}
	}()
	h, err := http.NewHttpConnection(conn)
	if err != nil {
		return nil, fmt.Errorf("ConnectToXpcServiceTunnelIface: failed to connect to http2: %w", err)
	}
	x, err := CreateXpcConnection(h)
	if err != nil {
		_ = h.Close()
	}
	return x, err
}

func ConnectToServiceTunnelIface(device DeviceEntry, serviceName string) (DeviceConnectionInterface, error) {
	if !device.SupportsRsd() {
		return nil, fmt.Errorf("ConnectToServiceTunnelIface: Cannot connect to %s, missing tunnel address and RSD port. To start the tunnel, run `ios tunnel start`", serviceName)
	}
	port, err := RsdPortForService(device.Rsd, serviceName)
	if err != nil {
		return nil, fmt.Errorf("ConnectToServiceTunnelIface: %w", err)
	}

	conn, err := ConnectTUNDevice(device.Address, port, device)
	if err != nil {
		return nil, fmt.Errorf("ConnectToServiceTunnelIface: failed to connect to tunnel: %w", err)
	}

	return NewDeviceConnectionWithConn(conn), nil
}

func CreateXpcConnection(h *http.HttpConnection) (*xpc.Connection, error) {
	clientServerChannel, err := h.OpenStream()
	if err != nil {
		return nil, fmt.Errorf("CreateXpcConnection: failed to open stream: %w", err)
	}
	serverClientChannel, err := h.OpenStream()
	if err != nil {
		return nil, fmt.Errorf("CreateXpcConnection: failed to open stream: %w", err)
	}
	err = initializeXpcConnection(clientServerChannel, serverClientChannel)
	if err != nil {
		return nil, fmt.Errorf("CreateXpcConnection: failed to initialize xpc connection: %w", err)
	}

	openStream := func() (io.ReadWriteCloser, error) {
		return h.OpenStream()
	}
	xpcConn, err := xpc.New(clientServerChannel, serverClientChannel, openStream, h)
	if err != nil {
		return nil, fmt.Errorf("CreateXpcConnection: failed to create xpc connection: %w", err)
	}

	return xpcConn, nil
}

// connectWithStartServiceResponse issues a Connect Message to UsbMuxd for the given deviceID on the given port
// enabling the newCodec for it. It also enables SSL on the new service connection if requested by StartServiceResponse.
// It returns an error containing the UsbMux error code should the connect fail.
func (muxConn *UsbMuxConnection) connectWithStartServiceResponse(deviceID int, startServiceResponse StartServiceResponse, pairRecord PairRecord) error {
	err := muxConn.Connect(deviceID, startServiceResponse.Port)
	if err != nil {
		return err
	}

	var sslerr error
	if startServiceResponse.EnableServiceSSL {
		if _, ok := serviceConfigurations[startServiceResponse.Service]; ok {
			sslerr = muxConn.deviceConn.EnableSessionSslHandshakeOnly(pairRecord)
		} else {
			sslerr = muxConn.deviceConn.EnableSessionSsl(pairRecord)
		}
		if sslerr != nil {
			return sslerr
		}
	}

	return nil
}

func ConnectLockdownWithSession(device DeviceEntry) (*LockDownConnection, error) {
	muxConnection, err := NewUsbMuxConnectionContext(device.ContextOrBackground())
	if err != nil {
		return nil, fmt.Errorf("USBMuxConnection failed with: %v", err)
	}

	pairRecord, err := muxConnection.ReadPair(device.Properties.SerialNumber)
	if err != nil {
		_ = muxConnection.Close()
		return nil, fmt.Errorf("read pair: %w", err)
	}

	lockdownConnection, err := muxConnection.ConnectLockdown(device.DeviceID)
	if err != nil {
		_ = muxConnection.Close()
		return nil, fmt.Errorf("lockdown connect: %w", err)
	}
	_, err = lockdownConnection.StartSession(pairRecord)
	if err != nil {
		_ = lockdownConnection.Conn().Close()
		return nil, fmt.Errorf("start session: %w", err)
	}
	return lockdownConnection, nil
}

func initializeXpcConnection(csWriter, ssWriter io.ReadWriter) error {
	err := xpc.EncodeMessage(csWriter, xpc.Message{
		Flags: xpc.AlwaysSetFlag,
		Body:  map[string]interface{}{},
		Id:    0,
	})
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to encode message: %w", err)
	}

	_, err = xpc.DecodeMessage(csWriter) // TODO : figure out if need to act on this frame
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to decode message: %w", err)
	}

	err = xpc.EncodeMessage(ssWriter, xpc.Message{
		Flags: xpc.InitHandshakeFlag | xpc.AlwaysSetFlag,
		Body:  nil,
		Id:    0,
	})
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to encode message 2: %w", err)
	}

	_, err = xpc.DecodeMessage(ssWriter) // TODO : figure out if need to act on this frame
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to decode message 2: %w", err)
	}

	err = xpc.EncodeMessage(csWriter, xpc.Message{
		Flags: 0x201, // alwaysSetFlag | 0x200
		Body:  nil,
		Id:    0,
	})
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to encode message 3: %w", err)
	}

	_, err = xpc.DecodeMessage(csWriter) // TODO : figure out if need to act on this frame
	if err != nil {
		return fmt.Errorf("initializeXpcConnection: failed to decode message 3: %w", err)
	}

	return nil
}

func ConnectTUNDevice(remoteIP string, port int, d DeviceEntry) (net.Conn, error) {
	if d.DialService == nil || remoteIP != d.Address || port < 1 || port > 65535 {
		return nil, fmt.Errorf("in-process dialer required")
	}
	return d.DialService(d.ContextOrBackground(), uint16(port))
}
func connectTUN(address string, port int) (net.Conn, error) {
	return nil, fmt.Errorf("in-process dialer required")
}
