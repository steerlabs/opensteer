package wire

import "encoding/json"

type Reason string

const (
	NativeServiceFailed     Reason = "native-service-failed"
	Cancelled               Reason = "cancelled"
	DeadlineExceeded        Reason = "deadline-exceeded"
	CandidateGone           Reason = "candidate-gone"
	IdentityMismatch        Reason = "identity-mismatch"
	USBMuxUnavailable       Reason = "usbmux-unavailable"
	TrustRequired           Reason = "trust-required"
	TrustPending            Reason = "trust-pending"
	TrustDenied             Reason = "trust-denied"
	PhoneLocked             Reason = "phone-locked"
	PairingRevoked          Reason = "pairing-revoked"
	PairingFailed           Reason = "pairing-failed"
	DeveloperModeRequired   Reason = "developer-mode-required"
	DeveloperModeUnknown    Reason = "developer-mode-status-unknown"
	ImageMissing            Reason = "developer-image-missing"
	ImageIncompatible       Reason = "developer-image-incompatible"
	ImageMountFailed        Reason = "developer-image-mount-failed"
	PersonalizationNetwork  Reason = "personalization-network-unavailable"
	PersonalizationRejected Reason = "personalization-rejected"
	TunnelFailed            Reason = "tunnel-failed"
	ServiceMissing          Reason = "native-service-missing"
	ProtocolUnsupported     Reason = "protocol-unsupported"
	UnsupportedIOS          Reason = "unsupported-ios"
	QualificationRequired   Reason = "qualification-required"
	PhoneInUse              Reason = "phone-in-use"
	MediaRequired           Reason = "input-media-session-required"
	MediaConflict           Reason = "input-media-conflict"
	PhoneDisconnected       Reason = "phone-disconnected"
	OwnedElsewhere          Reason = "owned-by-another-deployment"
	StaleEpoch              Reason = "stale-native-epoch"
	NoSession               Reason = "no-session"
	NotInitialized          Reason = "not-initialized"
	Unsupported             Reason = "unsupported"
)

// Same-LAN transport reasons are separate from USB trust and service readiness.
const (
	WifiNotEnabled                 Reason = "wifi-not-enabled"
	LocalNetworkPermissionRequired Reason = "local-network-permission-required"
	WifiPhoneNotFound              Reason = "wifi-phone-not-found"
	WifiPairingRequired            Reason = "wifi-pairing-required"
	WifiTransportUnsupported       Reason = "wifi-transport-unsupported"
	WifiIdentityMismatch           Reason = "wifi-identity-mismatch"
	// WifiPairingDenied means the phone's owner declined this Mac when the phone asked.
	WifiPairingDenied Reason = "wifi-pairing-denied"
	// WifiPairingFailed means Wi-Fi pairing over the cable did not finish; trying again can work.
	WifiPairingFailed Reason = "wifi-pairing-failed"
)

var Reasons = append([]Reason{NativeServiceFailed, Cancelled, DeadlineExceeded, CandidateGone, IdentityMismatch, USBMuxUnavailable, TrustRequired, TrustPending, TrustDenied, PhoneLocked, PairingRevoked, PairingFailed, DeveloperModeRequired, DeveloperModeUnknown, ImageMissing, ImageIncompatible, ImageMountFailed, PersonalizationNetwork, PersonalizationRejected, TunnelFailed, ServiceMissing, ProtocolUnsupported, UnsupportedIOS, QualificationRequired, PhoneInUse, MediaRequired, MediaConflict, PhoneDisconnected, OwnedElsewhere, StaleEpoch, NoSession, NotInitialized, Unsupported, WifiNotEnabled, LocalNetworkPermissionRequired, WifiPhoneNotFound, WifiPairingRequired, WifiTransportUnsupported, WifiIdentityMismatch, WifiPairingDenied, WifiPairingFailed}, screenReasons...)

type Failure struct {
	Code           Reason `json:"code"`
	Effect         string `json:"effect"`
	CompletedSteps int    `json:"completedSteps"`
}

func (f *Failure) Error() string { return string(f.Code) }
func Fail(code Reason) *Failure {
	return &Failure{Code: code, Effect: "not-started", CompletedSteps: 0}
}

type Response struct {
	Kind   string      `json:"kind"`
	ID     uint64      `json:"id"`
	Result interface{} `json:"result"`
}
type ErrorResult struct {
	Error *Failure `json:"error"`
}
type Request struct {
	Kind            string          `json:"kind"`
	ProtocolVersion int             `json:"protocolVersion"`
	ID              uint64          `json:"id"`
	TimeoutMs       int             `json:"timeoutMs"`
	Method          string          `json:"method"`
	Params          json.RawMessage `json:"params"`
}
type Empty struct{}

// Main-process-only: never project this result into public phone status.
type IdentityParams struct {
	CandidateID string `json:"candidateId"`
}
type IdentityResult struct {
	UDID string `json:"udid"`
}
type ForgetBindingParams struct {
	UDID             string `json:"udid"`
	DeploymentID     string `json:"deploymentId"`
	HostInstanceID   string `json:"hostInstanceId"`
	RunnerID         string `json:"runnerId"`
	DeviceID         string `json:"deviceId"`
	DriverGeneration uint64 `json:"driverGeneration"`
}
type PhoneRef struct {
	LocalPhoneID string `json:"localPhoneId"`
	NativeEpoch  uint64 `json:"nativeEpoch"`
}
type ImagesParams struct {
	ImageRoots []string `json:"imageRoots"`
}
type InitParams struct {
	PrivateRoot string   `json:"privateRoot"`
	ImageRoots  []string `json:"imageRoots"`
}
type ForgetParams struct {
	PhoneRef
	BindingToken string `json:"bindingToken"`
}
type CancelParams struct {
	RequestID uint64 `json:"requestId"`
}
type BindingParams struct {
	PhoneRef
	DeploymentID     string `json:"deploymentId"`
	HostInstanceID   string `json:"hostInstanceId"`
	RunnerID         string `json:"runnerId"`
	DeviceID         string `json:"deviceId"`
	DriverGeneration uint64 `json:"driverGeneration"`
}
type TokenParams struct {
	BindingToken string `json:"bindingToken"`
	Forget       bool   `json:"forget,omitempty"`
}
type SessionParams struct {
	BindingToken string `json:"bindingToken"`
	SessionID    string `json:"sessionId"`
	RunID        string `json:"runId"`
	Access       string `json:"access"`
}
type CloseParams struct {
	BindingToken string `json:"bindingToken"`
	SessionID    string `json:"sessionId"`
}
type Hello struct {
	Bridge          string `json:"bridge"`
	Version         string `json:"version"`
	ProtocolVersion int    `json:"protocolVersion"`
	BootID          string `json:"bootId"`
	Bounds          Bounds `json:"bounds"`
}
type Bounds struct {
	RequestBytes    int `json:"requestBytes"`
	ResponseBytes   int `json:"responseBytes"`
	EventBytes      int `json:"eventBytes"`
	PendingRequests int `json:"pendingRequests"`
	Roster          int `json:"roster"`
	BoundPhones     int `json:"boundPhones"`
	TimeoutMs       int `json:"timeoutMs"`
}

func HelloResult(boot string) Hello {
	return Hello{"opensteer-iphone-bridge", "0.1.0", 1, boot, Bounds{MaxRequestBytes, MaxResponseBytes, MaxEventBytes, MaxPending, 64, 8, MaxTimeoutMs}}
}

type Candidate struct {
	Trust        string        `json:"trust"`
	LocalPhoneID string        `json:"localPhoneId"`
	NativeEpoch  uint64        `json:"nativeEpoch"`
	Name         string        `json:"name"`
	Model        string        `json:"model"`
	OSVersion    string        `json:"osVersion"`
	Build        string        `json:"build"`
	Transport    string        `json:"transport"`
	Reason       *Reason       `json:"reason"`
	Capabilities *Capabilities `json:"capabilities,omitempty"`
}
type Capabilities struct {
	Observe        *Reason `json:"observe"`
	Act            *Reason `json:"act"`
	Launch         *Reason `json:"launch"`
	InstalledApps  *Reason `json:"installedApps"`
	Text           Reason  `json:"text"`
	Clear          Reason  `json:"clear"`
	IndexedTargets Reason  `json:"indexedTargets"`
	LiveVideo      Reason  `json:"liveVideo"`
}
type Roster struct {
	Revision   uint64      `json:"revision"`
	Candidates []Candidate `json:"candidates"`
}
type Event struct {
	Kind     string `json:"kind"`
	BootID   string `json:"bootId"`
	Sequence uint64 `json:"sequence"`
	Event    string `json:"event"`
	Roster   Roster `json:"roster"`
}

func Params(r Request) (interface{}, error) {
	var v interface{}
	switch r.Method {
	case "hello", "shutdown", "roster.get", "roster.subscribe":
		v = &Empty{}
	case "init":
		v = &InitParams{}
	case "images.refresh":
		v = &ImagesParams{}
	// Wi-Fi setup is main-process-only and always names an epoch-fenced phone.
	case "setup.enableWifi", "setup.disableWifi", "setup.pairWifi":
		v = &PhoneRef{}
	case "phone.identity":
		v = &IdentityParams{}
	case "binding.forget", "setup.withdrawWifi":
		v = &ForgetBindingParams{}
	case "setup.inspect", "setup.pair", "setup.revealDeveloperMode", "setup.prepareDeveloperServices":
		v = &PhoneRef{}
	case "phone.forget":
		v = &ForgetParams{}
	case "request.cancel":
		v = &CancelParams{}
	case "binding.acquire":
		v = &BindingParams{}
	case "binding.release", "binding.probe":
		v = &TokenParams{}
	case "session.open":
		v = &SessionParams{}
	case "session.close":
		v = &CloseParams{}
	default:
		v = screenParams(r.Method)
		if v == nil {
			return nil, ErrProtocol
		}
	}
	if len(r.Params) == 0 || r.Params[0] != '{' {
		return nil, ErrProtocol
	}
	if err := StrictDecode(r.Params, v); err != nil {
		return nil, err
	}
	validRef := func(p PhoneRef) bool {
		return p.LocalPhoneID != "" && len(p.LocalPhoneID) <= 128 && p.NativeEpoch > 0 && p.NativeEpoch <= 9007199254740991
	}
	switch p := v.(type) {
	case *ForgetBindingParams:
		if !validID(p.UDID) || !validID(p.DeploymentID) || !validID(p.HostInstanceID) || !validID(p.RunnerID) || !validID(p.DeviceID) || p.DriverGeneration == 0 || p.DriverGeneration > 9007199254740991 {
			return nil, ErrProtocol
		}
	case *IdentityParams:
		if !validID(p.CandidateID) {
			return nil, ErrProtocol
		}
	case *PhoneRef:
		if !validRef(*p) {
			return nil, ErrProtocol
		}
	case *ForgetParams:
		if !validRef(p.PhoneRef) || !validID(p.BindingToken) {
			return nil, ErrProtocol
		}
	case *InitParams:
		if p.PrivateRoot == "" || len(p.PrivateRoot) > 4096 || !validImageRoots(p.ImageRoots) {
			return nil, ErrProtocol
		}
	case *ImagesParams:
		if !validImageRoots(p.ImageRoots) {
			return nil, ErrProtocol
		}
	case *CancelParams:
		if p.RequestID == 0 || p.RequestID >= r.ID {
			return nil, ErrProtocol
		}
	case *BindingParams:
		if !validRef(p.PhoneRef) || !validID(p.DeploymentID) || !validID(p.HostInstanceID) || !validID(p.RunnerID) || !validID(p.DeviceID) || p.DriverGeneration == 0 || p.DriverGeneration > 9007199254740991 {
			return nil, ErrProtocol
		}
	case *TokenParams:
		if !validID(p.BindingToken) {
			return nil, ErrProtocol
		}
	case *SessionParams:
		if !validID(p.BindingToken) || !validID(p.SessionID) || !validID(p.RunID) || (p.Access != "observe" && p.Access != "control") {
			return nil, ErrProtocol
		}
	case *CloseParams:
		if !validID(p.BindingToken) || !validID(p.SessionID) {
			return nil, ErrProtocol
		}
	}
	if err := validateScreenParams(v); err != nil {
		return nil, err
	}
	return v, nil
}
func validID(s string) bool { return len(s) > 0 && len(s) <= 128 }
func DecodeRequest(b []byte) (Request, error) {
	var r Request
	if len(b) > MaxRequestBytes || StrictDecode(b, &r) != nil {
		return r, ErrProtocol
	}
	if r.Kind != "request" || r.ProtocolVersion != 1 || r.ID == 0 || r.ID > 9007199254740991 || r.TimeoutMs < 1 || r.TimeoutMs > MaxTimeoutMs {
		return r, ErrProtocol
	}
	if r.Method != "setup.prepareDeveloperServices" && r.Method != "binding.probe" && r.Method != "session.open" && r.TimeoutMs > 30000 {
		return r, ErrProtocol
	}
	_, err := Params(r)
	return r, err
}

func validImageRoots(roots []string) bool {
	if roots == nil || len(roots) > 8 {
		return false
	}
	for _, root := range roots {
		if root == "" || len(root) > 4096 {
			return false
		}
	}
	return true
}
