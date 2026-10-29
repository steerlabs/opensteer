import Foundation

/// `{"hash","seq","v":1}`: the tip of the history, in HEAD on disk, and with
/// the vault ID as the checkpoint in the `ProtectedStore`.
struct HeadPointer: Equatable {
  let hash: String
  let seq: Int64

  static let maxBytes = 4096

  func bytes() throws -> Data {
    try CanonicalJSON.encode(.object(["hash": .string(hash), "seq": .integer(seq), "v": .integer(1)]))
  }

  init(hash: String, seq: Int64) {
    self.hash = hash
    self.seq = seq
  }

  init(bytes: Data) throws {
    let object = try versioned(bytes, keys: ["hash", "seq", "v"], context: "HEAD", corrupt: .corruptHead)
    do {
      hash = try object.string("hash")
      seq = try object.integer("seq")
    } catch {
      throw VaultError.corruptHead
    }
    guard Hex.isSHA256(hash), seq >= 0 else { throw VaultError.corruptHead }
  }
}

/// A canonical object of `keys` with `"v":1`: another version is
/// `unsupportedVersion`, anything else malformed is `corrupt`.
private func versioned(_ bytes: Data, keys: Set<String>, context: String, corrupt: VaultError) throws -> StrictObject {
  let value: JSONValue
  do {
    value = try CanonicalJSON.parseCanonical(bytes)
  } catch {
    throw corrupt
  }
  if let version = formatVersion(of: value), version > 1 { throw VaultError.unsupportedVersion }
  do {
    let object = try StrictObject(value, keys: keys, context: context)
    guard try object.integer("v") == 1 else { throw corrupt }
    return object
  } catch {
    throw corrupt
  }
}

/// `{"hash","seq","v":1,"vaultId"}`.
struct Checkpoint: Equatable {
  let vaultId: String
  let head: HeadPointer

  func bytes() throws -> Data {
    try CanonicalJSON.encode(.object([
      "hash": .string(head.hash), "seq": .integer(head.seq), "v": .integer(1), "vaultId": .string(vaultId),
    ]))
  }

  init(vaultId: String, head: HeadPointer) {
    self.vaultId = vaultId
    self.head = head
  }

  init(bytes: Data) throws {
    let object = try versioned(bytes, keys: ["hash", "seq", "v", "vaultId"], context: "checkpoint", corrupt: .corruptCheckpoint)
    do {
      vaultId = try object.string("vaultId")
      head = HeadPointer(hash: try object.string("hash"), seq: try object.integer("seq"))
    } catch {
      throw VaultError.corruptCheckpoint
    }
    guard VaultIDs.isUUID(vaultId), Hex.isSHA256(head.hash), head.seq >= 0 else { throw VaultError.corruptCheckpoint }
  }
}

/// The vault folder:
///
///     HEAD                     canonical {"hash","seq"}
///     commits/<seq:012>.json   canonical signed commits
///     objects/<sha256 hex>     canonical sealed objects
///
/// Hidden files (leftover temp files from an interrupted write) are ignored.
struct VaultStore {
  static let maxObjectBytes = 8 << 20

  let root: URL
  var headURL: URL { root.appendingPathComponent("HEAD") }
  var commitsURL: URL { root.appendingPathComponent("commits") }
  var objectsURL: URL { root.appendingPathComponent("objects") }

  static func makeLayout(at root: URL) throws {
    try AtomicFile.makePrivateDirectory(root)
    try AtomicFile.makePrivateDirectory(root.appendingPathComponent("commits"))
    try AtomicFile.makePrivateDirectory(root.appendingPathComponent("objects"))
  }

  func readHead() throws -> HeadPointer {
    guard let bytes = try readFile(headURL, maxBytes: HeadPointer.maxBytes, onTooLarge: .corruptHead) else {
      throw VaultError.headMissing
    }
    return try HeadPointer(bytes: bytes)
  }

  func writeHead(_ head: HeadPointer) throws {
    try AtomicFile.write(try head.bytes(), to: headURL, exclusive: false)
  }

  func commitURL(_ seq: Int64) -> URL {
    let digits = String(seq)
    return commitsURL.appendingPathComponent(String(repeating: "0", count: max(0, 12 - digits.count)) + digits + ".json")
  }

  func readCommit(_ seq: Int64) throws -> Data? {
    try readFile(commitURL(seq), maxBytes: Commit.maxBytes, onTooLarge: .corruptCommit(seq: seq, reason: "too large"))
  }

  /// Exclusive: a second writer from the same parent fails here.
  func writeCommit(_ seq: Int64, _ bytes: Data) throws {
    do {
      try AtomicFile.write(bytes, to: commitURL(seq), exclusive: true)
    } catch StorageError.alreadyExists {
      throw VaultError.headMoved
    }
  }

  /// Only for a commit whose checkpoint write failed, before HEAD named it.
  func removeCommit(_ seq: Int64) throws {
    try AtomicFile.remove(commitURL(seq))
  }

  /// The sequence numbers present. Any visible name other than a 12-digit
  /// `.json` file is an error.
  func commitSeqs() throws -> [Int64] {
    let names = try FileManager.default.contentsOfDirectory(atPath: commitsURL.path)
    var seqs: [Int64] = []
    for name in names where !name.hasPrefix(".") {
      let stem = name.dropLast(5)
      guard name.hasSuffix(".json"), stem.count == 12, stem.allSatisfy(\.isASCII), stem.allSatisfy(\.isNumber),
        let seq = Int64(stem)
      else { throw VaultError.unexpectedFile(name) }
      seqs.append(seq)
    }
    return seqs.sorted()
  }

  /// Reads an object and checks it hashes to its name.
  func readObject(_ hash: String) throws -> Data {
    guard Hex.isSHA256(hash) else { throw VaultError.corruptObject(hash) }
    guard let bytes = try readFile(objectsURL.appendingPathComponent(hash), maxBytes: Self.maxObjectBytes, onTooLarge: .corruptObject(hash)) else {
      throw VaultError.missingObject(hash)
    }
    guard Hex.sha256(bytes) == hash else { throw VaultError.corruptObject(hash) }
    return bytes
  }

  /// Writes an object under its hash. An existing file must already hold
  /// exactly these bytes.
  @discardableResult
  func writeObject(_ bytes: Data) throws -> String {
    let hash = Hex.sha256(bytes)
    let url = objectsURL.appendingPathComponent(hash)
    if AtomicFile.exists(url) {
      _ = try readObject(hash)
      return hash
    }
    try AtomicFile.write(bytes, to: url, exclusive: false)
    return hash
  }

  private func readFile(_ url: URL, maxBytes: Int, onTooLarge: VaultError) throws -> Data? {
    do {
      return try AtomicFile.read(url, maxBytes: maxBytes)
    } catch StorageError.tooLarge {
      throw onTooLarge
    }
  }
}
