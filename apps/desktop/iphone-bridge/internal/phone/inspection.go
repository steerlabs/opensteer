package phone

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type passiveInspector interface {
	PassiveInspect(context.Context, ios.DeviceEntry) (Inspection, error)
}

type inspectionAttempt struct {
	ref       wire.PhoneRef
	phone     *localPhone
	next      time.Time
	backoff   time.Duration
	running   bool
	completed bool
}

type inspectionResult struct {
	attempt  *inspectionAttempt
	complete bool
}

func (m *Manager) wakeInspections() {
	select {
	case m.inspectionWake <- struct{}{}:
	default:
	}
}

func (m *Manager) startInspectionsLocked() {
	inspector, ok := m.usb.(passiveInspector)
	if !ok {
		return
	}
	if !m.inspecting {
		m.inspecting = true
		m.wg.Go(func() { m.inspectCandidates(inspector) })
	}
	m.wakeInspections()
}

// The scheduler owns retries and at most four attempts; waiting phones own no goroutine.
func (m *Manager) inspectCandidates(inspector passiveInspector) {
	jobs := map[wire.PhoneRef]*inspectionAttempt{}
	finished := make(chan inspectionResult, 4)
	var attempts sync.WaitGroup
	defer attempts.Wait()
	active := 0
	for m.workCtx.Err() == nil {
		now := time.Now()
		m.mu.Lock()
		for ref, job := range jobs {
			p := m.phones[ref.LocalPhoneID]
			if p != job.phone || p.epoch != ref.NativeEpoch || p.entry.Properties.ConnectionType != "USB" {
				delete(jobs, ref)
			}
		}
		for _, p := range m.phones {
			if p.entry.DeviceID > 0 && p.entry.Properties.ConnectionType == "USB" {
				ref := wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}
				if jobs[ref] == nil {
					jobs[ref] = &inspectionAttempt{ref: ref, phone: p}
				}
			}
		}
		pending := make([]*inspectionAttempt, 0, len(jobs))
		for _, job := range jobs {
			if !job.running && !job.completed && job.phone.operations == 0 && job.phone.sessionID == "" {
				pending = append(pending, job)
			}
		}
		sort.Slice(pending, func(i, j int) bool {
			if pending[i].next.Equal(pending[j].next) {
				return pending[i].ref.LocalPhoneID < pending[j].ref.LocalPhoneID
			}
			return pending[i].next.Before(pending[j].next)
		})
		var next time.Time
		for _, job := range pending {
			if active == 4 {
				break
			}
			if job.next.After(now) {
				next = job.next
				break
			}
			p := job.phone
			select {
			case p.lane <- struct{}{}:
			default:
				continue
			}
			job.running = true
			done := make(chan struct{})
			p.inspectionDone = done
			active++
			entry := p.entry
			ctx, cancel := context.WithTimeout(m.workCtx, 3*time.Second)
			stop := context.AfterFunc(p.routeCtx, cancel)
			attempts.Go(func() {
				complete := false
				defer func() {
					stop()
					cancel()
					<-p.lane
					m.mu.Lock()
					if p.inspectionDone == done {
						p.inspectionDone = nil
					}
					m.mu.Unlock()
					close(done)
					finished <- inspectionResult{attempt: job, complete: complete}
				}()
				inspection, err := inspector.PassiveInspect(ctx, entry)
				if err != nil {
					inspection.Reason = Classify(err, wire.NativeServiceFailed).Code
				}
				complete = inspectionComplete(inspection, err)
				if inspection.Pairing != "paired" {
					inspection = Inspection{Reason: inspection.Reason}
				}
				m.mu.Lock()
				valid := m.phones[p.id] == p && p.epoch == job.ref.NativeEpoch && p.entry.DeviceID == entry.DeviceID && ctx.Err() == nil && !m.closed
				if valid {
					p.inspection = inspection
					m.revision++
				}
				m.mu.Unlock()
				complete = valid && complete
				if valid && m.publish != nil {
					m.publish(m.roster())
				}
			})
		}
		m.mu.Unlock()
		var timer *time.Timer
		var retry <-chan time.Time
		if !next.IsZero() {
			timer = time.NewTimer(time.Until(next))
			retry = timer.C
		}
		select {
		case <-m.workCtx.Done():
		case <-m.inspectionWake:
		case <-retry:
		case result := <-finished:
			job := result.attempt
			active--
			job.running = false
			job.completed = result.complete
			job.backoff = min(max(time.Second, job.backoff*2), 30*time.Second)
			job.next = time.Now().Add(job.backoff)
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func inspectionComplete(inspection Inspection, err error) bool {
	if err == nil || (inspection.Pairing == "paired" && inspection.Name != "" && inspection.Model != "" && inspection.OSVersion != "" && inspection.Build != "") {
		return true
	}
	switch inspection.Reason {
	case wire.TrustRequired, wire.TrustDenied, wire.PairingRevoked, wire.Unsupported, wire.UnsupportedIOS, wire.ProtocolUnsupported:
		return true
	}
	return false
}
