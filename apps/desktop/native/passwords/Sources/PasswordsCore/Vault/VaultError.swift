import Foundation

/// Every vault inconsistency is an error. Nothing is repaired or skipped,
/// except adopting a fully verified commit a crash left without HEAD.
public enum VaultError: Error, Equatable, Sendable {
  case notFound
  case alreadyExists
  case headMissing
  case corruptHead
  /// HEAD names a hash that is not the commit at its sequence number.
  case headMismatch
  case checkpointMissing
  case corruptCheckpoint
  /// The folder's history is older than, forked from, or not the vault this
  /// Mac accepted.
  case rollbackDetected
  case missingCommit(seq: Int64)
  case unexpectedFile(String)
  /// A commit beyond the one a crash may have left.
  case unexpectedCommit(seq: Int64)
  case corruptCommit(seq: Int64, reason: String)
  case brokenChain(seq: Int64)
  case badSignature(seq: Int64)
  case unauthorizedSigner(seq: Int64)
  case missingObject(String)
  case corruptObject(String)
  case unsupportedVersion
  /// The epoch key or manifest did not decrypt.
  case decryptionFailed
  /// The owner key is not in the head commit's membership.
  case notAMember
  case closed
  /// Another writer committed since this vault was opened.
  case headMoved
  case noChanges
  case invalidItem(String)
  case invalidGrant(String)
  case itemNotFound(String)
  case tooManyItems
  case tooManyGrants
  case invalidDeviceName
  case signerProducedInvalidSignature
}
