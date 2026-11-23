// Package display starts RTP video streams over
// com.apple.coredevice.displayservice.
package display

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/coredevice"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/google/uuid"
)

const logModule = "go-ios/display"

const (
	serviceName = "com.apple.coredevice.displayservice"

	featureStartMediaStream = "com.apple.coredevice.feature.startmediastream"
	featureStopMediaStream  = "com.apple.coredevice.feature.stopmediastream"

	actionMediaStreamStart = "com.apple.coredevice.action.mediastreamstart"
	actionMediaStreamStop  = "com.apple.coredevice.action.mediastreamstop"

	// Host capabilities and link type. The values Xcode sends over a tunnel, with
	// no documented meaning to derive them from.
	clientSupportedFeatures = uint64(140)
	accessNetworkType       = int64(1)
	transportProtocolType   = int64(2)

	// Stream idle timeout sent to CoreDevice (matches Xcode Device Hub).
	streamTimeoutSeconds = uint64(3600)

	DefaultDisplayID       = 1
	DefaultAudioSenderPort = 50000
	DefaultVideoSenderPort = 50001
)

// Service is a connection to the device's display service. One request runs at a
// time: nothing in the XPC framing pairs a reply with its request (see invoke).
type Service struct {
	conn     xpcConn
	deviceID string
	mutex    sync.Mutex
}

// xpcConn is the subset of *xpc.Connection used here, so the request/reply logic
// can be exercised with a fake.
type xpcConn interface {
	Send(data map[string]interface{}, flags ...uint32) error
	ReceiveOnServerClientStream() (map[string]interface{}, error)
	Close() error
}

// New connects to the display service. The Developer Disk Image must be
// mounted, otherwise the service is not published and connecting fails.
func New(device ios.DeviceEntry) (*Service, error) {
	conn, err := ios.ConnectToXpcServiceTunnelIface(device, serviceName)
	if err != nil {
		return nil, fmt.Errorf("display.New: failed to connect to %s: %w", serviceName, err)
	}
	return &Service{conn: conn, deviceID: uuid.New().String()}, nil
}

// Close closes the connection to the display service. Stop any running stream
// first, otherwise the device keeps sending RTP until it times out.
func (s *Service) Close() error {
	return s.conn.Close()
}

// VideoStreamRequest describes where the device should send a display's frames.
// The receiver must already be bound: the device sends as soon as it answers.
type VideoStreamRequest struct {
	// ReceiverIP and ReceiverPort are the host's tunnel address and bound UDP
	// port, as reported by a Receiver.
	ReceiverIP   string
	ReceiverPort int
	// SenderIP is the device's address over the tunnel (ios.DeviceEntry.Address).
	SenderIP string
	// SenderPort is the device's RTP source port; defaults to DefaultVideoSenderPort.
	SenderPort int
	// DisplayID selects the display; use DefaultDisplayID for the main one.
	DisplayID int
	// ClientSessionID binds audio and video to one screen-sharing session.
	ClientSessionID uuid.UUID
}

// AudioStreamRequest establishes the CoreDevice screen-sharing session before video.
type AudioStreamRequest struct {
	ReceiverIP      string
	ReceiverPort    int
	SenderIP        string
	SenderPort      int
	ClientSessionID uuid.UUID
}

// StartAudioStreamWithOffer starts the audio half of a CoreDevice screen-sharing session.
// Starting audio first on the shared ClientSessionID initializes the device's screen video rules.
func (s *Service) StartAudioStreamWithOffer(ctx context.Context, req AudioStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	if req.ReceiverIP == "" || req.ReceiverPort < 1 || req.ReceiverPort > 65535 {
		return uuid.Nil, nil, fmt.Errorf("StartAudioStreamWithOffer: receiver address is required")
	}
	if req.SenderIP == "" {
		return uuid.Nil, nil, fmt.Errorf("StartAudioStreamWithOffer: sender address is required")
	}
	if len(offer) == 0 {
		return uuid.Nil, nil, errors.New("display: audio offer is required")
	}
	senderPort := req.SenderPort
	if senderPort <= 0 || senderPort > 65535 {
		senderPort = DefaultAudioSenderPort
	}
	clientSessionID := req.ClientSessionID
	if clientSessionID == uuid.Nil {
		clientSessionID = uuid.New()
	}
	input := map[string]interface{}{
		"clientSupportedFeatures": clientSupportedFeatures,
		"direction":               "output",
		"negotiatorOffer":         offer,
		"options": map[string]interface{}{
			"AVCMediaStreamNegotiatorAccessNetworkType":     map[string]interface{}{"int": accessNetworkType},
			"AVCMediaStreamNegotiatorTransportProtocolType": map[string]interface{}{"int": transportProtocolType},
			"avcMediaStreamOptionClientSessionID":           map[string]interface{}{"uuid": clientSessionID},
		},
		"receiverIP":   req.ReceiverIP,
		"receiverPort": uint64(req.ReceiverPort),
		"senderIP":     req.SenderIP,
		"senderPort":   uint64(senderPort),
		"timeout":      streamTimeoutSeconds,
		"type":         "audio",
	}
	output, err := s.invoke(ctx, featureStartMediaStream, actionMediaStreamStart, input)
	return clientSessionID, output, err
}

// StartVideoStreamWithOffer starts an RTP video stream of one display. iOS 27+, earlier
// fails 9021. Pass a deadline: the daemon can stop answering, so close on timeout.
func (s *Service) StartVideoStreamWithOffer(ctx context.Context, req VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	if req.ReceiverIP == "" || req.ReceiverPort < 1 || req.ReceiverPort > 65535 {
		return uuid.Nil, nil, fmt.Errorf("StartVideoStreamWithOffer: receiver address is required, bind a Receiver first")
	}
	if req.SenderIP == "" {
		return uuid.Nil, nil, fmt.Errorf("StartVideoStreamWithOffer: sender address is required")
	}
	displayID := req.DisplayID
	if displayID == 0 {
		displayID = DefaultDisplayID
	}
	senderPort := req.SenderPort
	if senderPort <= 0 || senderPort > 65535 {
		senderPort = DefaultVideoSenderPort
	}

	if len(offer) == 0 {
		return uuid.Nil, nil, errors.New("display: video offer is required")
	}
	clientSessionID := req.ClientSessionID
	if clientSessionID == uuid.Nil {
		clientSessionID = uuid.New()
	}

	input := map[string]interface{}{
		"clientSupportedFeatures": clientSupportedFeatures,
		"direction":               "output",
		"negotiatorOffer":         offer,
		"options": map[string]interface{}{
			"AVCMediaStreamNegotiatorAccessNetworkType":     map[string]interface{}{"int": accessNetworkType},
			"AVCMediaStreamNegotiatorTransportProtocolType": map[string]interface{}{"int": transportProtocolType},
			"CoreDeviceVideoDisplayMode":                    map[string]interface{}{"string": "DisplayByID"},
			"VideoStreamForDisplayID":                       map[string]interface{}{"int": int64(displayID)},
			"avcMediaStreamOptionClientSessionID":           map[string]interface{}{"uuid": clientSessionID},
		},
		"receiverIP":   req.ReceiverIP,
		"receiverPort": uint64(req.ReceiverPort),
		"senderIP":     req.SenderIP,
		"senderPort":   uint64(senderPort),
		"timeout":      streamTimeoutSeconds,
		"type":         "video",
	}

	// Return the ID even on error: the device may have started the stream.
	output, err := s.invoke(ctx, featureStartMediaStream, actionMediaStreamStart, input)
	return clientSessionID, output, err
}

// StopMediaStream retains the legacy stop-all behavior for existing callers.
func (s *Service) StopMediaStream(ctx context.Context, clientSessionID uuid.UUID) error {
	return s.StopMediaStreamScoped(ctx, clientSessionID, true)
}

// StopMediaStreamScoped stops this client's stream unless stopAll is explicit.
func (s *Service) StopMediaStreamScoped(ctx context.Context, clientSessionID uuid.UUID, stopAll bool) error {
	if clientSessionID == uuid.Nil {
		return errors.New("display: client session ID is required")
	}
	input := map[string]interface{}{
		"avcMediaStreamOptionClientSessionID": map[string]interface{}{"uuid": clientSessionID},
		"stopAll":                             stopAll,
	}
	_, err := s.invoke(ctx, featureStopMediaStream, actionMediaStreamStop, input)
	return err
}

// invoke sends one CoreDevice request and waits for its response, honouring ctx.
//
// An interrupted exchange may have consumed part of a message, and nothing
// reports whether it did, so the connection is closed rather than reused: there
// is no way to resynchronise and no id to catch a reply meant for someone else.
func (s *Service) invoke(ctx context.Context, feature, action string, input map[string]interface{}) (map[string]interface{}, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Neither a blocked read nor a blocked write can be cancelled, so closing the
	// connection is what ends them. It is discarded either way, so nothing is lost
	// by being blunt.
	stop := context.AfterFunc(ctx, func() { _ = s.conn.Close() })
	defer stop()

	request := coredevice.BuildRequestWithAction(s.deviceID, feature, action, input)
	if err := s.conn.Send(request, xpc.HeartbeatRequestFlag); err != nil {
		_ = s.conn.Close()
		return nil, fmt.Errorf("display: failed to send %s: %w", feature, err)
	}

	response, err := s.conn.ReceiveOnServerClientStream()
	if err != nil {
		_ = s.conn.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("display: %s did not complete: %w (the device's mediastream daemon may be wedged; rebooting the device clears it)", feature, ctxErr)
		}
		if feature == featureStopMediaStream && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET)) {
			return map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("display: failed to receive the response to %s: %w", feature, err)
	}

	if err := coredevice.ResponseError(response); err != nil {
		return nil, err
	}
	output, ok := response["CoreDevice.output"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("display: unexpected response to %s", feature)
	}
	return output, nil
}
