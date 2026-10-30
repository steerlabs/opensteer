import AVFoundation

/// Pumps conversion through end-of-stream so the resampler's buffered tail survives stop.
func convertAudio(
  _ converter: AVAudioConverter, buffer: AVAudioPCMBuffer?,
  send: (AVAudioPCMBuffer) async throws -> Void
) async throws {
  var supplied = false
  while true {
    guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 4096)
    else { throw DictationError.recognitionFailed }
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if let buffer, !supplied {
        supplied = true
        state.pointee = .haveData
        return buffer
      }
      state.pointee = buffer == nil ? .endOfStream : .noDataNow
      return nil
    }
    if error != nil || status == .error { throw DictationError.recognitionFailed }
    if output.frameLength > 0 {
      try await send(output)
    }
    if status == .endOfStream || status == .inputRanDry { return }
  }
}
