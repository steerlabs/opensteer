import Foundation

public enum PhoneBrowserFrames {
  public static let maxFrameBytes = 8 * 1024 * 1024
  public static let maxHeaderBytes = 16 * 1024

  public static func envelope(header: [String: Any], payload: Data) throws -> Data {
    let json = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys, .withoutEscapingSlashes])
    guard !json.isEmpty, json.count <= maxHeaderBytes else { throw PhoneBrowserFailure.invalidFrame }
    var length = UInt32(json.count).bigEndian
    return withUnsafeBytes(of: &length) { Data($0) } + json + payload
  }

  public static func split(_ bytes: Data) throws -> (header: [String: Any], payload: Data) {
    guard bytes.count >= 4 else { throw PhoneBrowserFailure.invalidFrame }
    let length = bytes.prefix(4).reduce(0) { $0 * 256 + Int($1) }
    guard length > 0, length <= maxHeaderBytes, bytes.count > length + 4 else { throw PhoneBrowserFailure.invalidFrame }
    let headerBytes = Data(bytes.dropFirst(4).prefix(length))
    guard !headerBytes.starts(with: [0xef, 0xbb, 0xbf]), String(data: headerBytes, encoding: .utf8) != nil,
      let header = try JSONSerialization.jsonObject(with: headerBytes) as? [String: Any] else { throw PhoneBrowserFailure.invalidFrame }
    return (header, Data(bytes.dropFirst(4 + length)))
  }

  public static func validateFrame(_ bytes: Data) throws {
    guard bytes.count <= maxFrameBytes else { throw PhoneBrowserFailure.invalidFrame }
    let (header, _) = try split(bytes)
    let required = ["encoding", "frameId", "rasterHeight", "rasterWidth", "surfaceId", "viewportHeight", "viewportWidth"]
    guard Set(required).isSubset(of: Set(header.keys)),
      Set(header.keys).isSubset(of: Set(required + ["capture", "geometryRevision", "watchToken"])),
      ["jpeg", "png", "webp"].contains(header["encoding"] as? String ?? "") else { throw PhoneBrowserFailure.invalidFrame }
    guard PhoneBrowserValidation.surface(header["surfaceId"]) else { throw PhoneBrowserFailure.invalidFrame }
    _ = try WireField.int(header, "frameId", range: 0...9_007_199_254_740_991)
    _ = try WireField.int(header, "rasterWidth", range: 1...7680)
    _ = try WireField.int(header, "rasterHeight", range: 1...4320)
    let viewportWidth = try PhoneBrowserValidation.number(header, "viewportWidth", range: Double.leastNonzeroMagnitude...16_384)
    let viewportHeight = try PhoneBrowserValidation.number(header, "viewportHeight", range: Double.leastNonzeroMagnitude...16_384)
    if header["geometryRevision"] != nil { _ = try WireField.int(header, "geometryRevision", range: 0...9_007_199_254_740_991) }
    if header["watchToken"] != nil, !PhoneBrowserValidation.uuid(header["watchToken"]) { throw PhoneBrowserFailure.invalidFrame }
    if header["capture"] != nil {
      let capture = try WireField.object(header, "capture")
      guard Set(capture.keys) == Set(["width", "height", "revision"]), header["geometryRevision"] != nil else { throw PhoneBrowserFailure.invalidFrame }
      _ = try WireField.int(capture, "revision", range: 0...9_007_199_254_740_991)
      _ = try PhoneBrowserValidation.number(capture, "width", range: Double.leastNonzeroMagnitude...viewportWidth)
      _ = try PhoneBrowserValidation.number(capture, "height", range: Double.leastNonzeroMagnitude...viewportHeight)
    }
  }

  public static func relay(header: [String: Any], frame: Data) throws -> Data {
    try validateFrame(frame)
    try validateRelayHeader(header)
    return try envelope(header: header, payload: frame)
  }

  public static func decodeRelay(_ bytes: Data) throws -> (header: [String: Any], payload: Data) {
    guard bytes.count <= maxFrameBytes + maxHeaderBytes + 4 else { throw PhoneBrowserFailure.invalidFrame }
    let decoded = try split(bytes)
    try validateRelayHeader(decoded.header)
    try validateFrame(decoded.payload)
    return decoded
  }

  private static func validateRelayHeader(_ header: [String: Any]) throws {
    try WireField.type(header, "browser.frame")
    let fence = try AuxiliaryFence(header)
    try PhoneBrowserValidation.fence(header)
    guard fence.module == "browser", header.count == 11 else { throw PhoneBrowserFailure.invalidFrame }
    _ = try WireField.int(header, "sequence", range: 0...9_007_199_254_740_991)
    guard PhoneBrowserValidation.identifier(try WireField.string(header, "channelId"), prefix: "bch") else { throw PhoneBrowserFailure.invalidFrame }
    let capability = try WireField.object(header, "capability")
    guard capability.count == 3 else { throw PhoneBrowserFailure.invalidFrame }
    _ = try WireField.string(capability, "runtimeId")
    guard PhoneBrowserValidation.identifier(try WireField.string(capability, "capabilityLeaseId"), prefix: "bcl") else { throw PhoneBrowserFailure.invalidFrame }
    _ = try WireField.int(capability, "capabilityGeneration", range: 1...9_007_199_254_740_991)
  }
}

public protocol PhoneBrowserFrameWriter: AnyObject {
  func writeFrame(header: [String: Any], pixels: Data, completion: @escaping (Bool) -> Void)
  func writePixelResult(message: [String: Any], dataPath: [String], pixels: Data, completion: @escaping (Bool) -> Void)
}
