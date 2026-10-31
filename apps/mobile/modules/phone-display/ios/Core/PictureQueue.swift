import CoreGraphics
import Foundation

/// What became of one delivered picture. JavaScript returns the delivery's
/// receipt on every outcome, so each is reported exactly once.
enum PictureOutcome: String {
  case presented, failed, dropped
}

/// One delivered picture as JavaScript describes it.
struct PictureRequest: Equatable {
  /// The view's clear generation the delivery was sent for; an older one never draws.
  var generation: Int
  /// Pictures sharing a fence share input geometry. A newer delivery under
  /// another fence supersedes a decode still in progress.
  var fence: String
  /// The encoded raster, which the decoded image must match exactly.
  var width: Int
  var height: Int
  /// The page region the raster shows, laid out with aspect-fit.
  var regionWidth: Double
  var regionHeight: Double
  /// A cropped capture keeps native size rather than growing past it.
  var upscale: Bool
  var cornerRadius: Double

  /// Where the raster draws inside a view of `size`, centred; nil when either is empty.
  func rect(in size: CGSize) -> CGRect? {
    let values = [Double(size.width), Double(size.height), Double(width), Double(height), regionWidth, regionHeight]
    guard values.allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
    let scale = min(upscale ? .infinity : 1, Double(size.width) / regionWidth, Double(size.height) / regionHeight)
    let fitted = CGSize(width: regionWidth * scale, height: regionHeight * scale)
    return CGRect(x: (size.width - fitted.width) / 2, y: (size.height - fitted.height) / 2, width: fitted.width, height: fitted.height)
  }
}

/// Settles one delivery once; later calls do nothing.
final class PictureReceipt {
  private var settle: ((PictureOutcome) -> Void)?
  init(_ settle: @escaping (PictureOutcome) -> Void) { self.settle = settle }
  func callAsFunction(_ outcome: PictureOutcome) {
    let settle = self.settle
    self.settle = nil
    settle?(outcome)
  }
}

/// One view's deliveries: at most one decoding and the newest waiting, so
/// memory stays bounded at the shown image, one decoding and one encoded
/// picture. Confined to one thread; decoding happens elsewhere.
final class PictureQueue<Payload> {
  struct Job {
    let request: PictureRequest
    let payload: Payload
    let receipt: PictureReceipt
  }

  private(set) var generation = 0
  /// A decode is running. It stays true after a clear until that decode returns,
  /// so a clear never starts a second decode beside an abandoned one.
  private var running = false
  private var decoding: Job?
  private var pending: Job?

  /// Takes a delivery and returns the job to decode now, if the decoder is free.
  func submit(_ request: PictureRequest, _ payload: Payload, _ receipt: PictureReceipt) -> Job? {
    guard request.generation == generation else { receipt(.dropped); return nil }
    let job = Job(request: request, payload: payload, receipt: receipt)
    guard !running else {
      pending?.receipt(.dropped)
      pending = job
      return nil
    }
    running = true
    decoding = job
    return job
  }

  /// The running decode returned. `shown` is the job to draw now, after which
  /// its receipt settles as presented; `next` is the job to decode next.
  func complete(decoded: Bool) -> (shown: Job?, next: Job?) {
    running = false
    var shown: Job?
    if let finished = decoding {
      decoding = nil
      if !decoded {
        finished.receipt(.failed)
      } else if finished.request.generation != generation || (pending.map { $0.request.fence != finished.request.fence } ?? false) {
        finished.receipt(.dropped)
      } else {
        shown = finished
      }
    }
    guard let next = pending else { return (shown, nil) }
    pending = nil
    running = true
    decoding = next
    return (shown, next)
  }

  /// Drops every delivery not yet shown; only `generation` may draw afterwards.
  func clear(_ generation: Int) {
    self.generation = generation
    decoding?.receipt(.dropped)
    decoding = nil
    pending?.receipt(.dropped)
    pending = nil
  }
}
