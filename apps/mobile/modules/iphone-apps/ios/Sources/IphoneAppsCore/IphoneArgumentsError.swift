/// Argument failures stay within the existing wire error without changing the
/// shared Mac helper's closed error enum.
public struct IphoneArgumentsError: Error, Sendable {
  public let message: String
  public init(_ message: String) { self.message = message }
}
