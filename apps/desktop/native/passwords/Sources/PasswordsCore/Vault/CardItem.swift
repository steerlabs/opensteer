import Foundation

public struct CardDraft: Sendable {
  public var number: String
  public var expiryMonth: Int64
  public var expiryYear: Int64
  public var cvc: String
  public var name: String?
  public var label: String?
  public var postalCode: String?

  public init(number: String, expiryMonth: Int64, expiryYear: Int64, cvc: String,
              name: String? = nil, label: String? = nil, postalCode: String? = nil) {
    self.number = number
    self.expiryMonth = expiryMonth
    self.expiryYear = expiryYear
    self.cvc = cvc
    self.name = name
    self.label = label
    self.postalCode = postalCode
  }

  func validateLimits() throws {
    guard (12...19).contains(number.utf8.count), (3...4).contains(cvc.utf8.count),
      (1...12).contains(expiryMonth), (1000...9999).contains(expiryYear),
      [name, label].allSatisfy({ $0 == nil || (1...200).contains($0!.utf8.count) }),
      postalCode == nil || (1...32).contains(postalCode!.utf8.count)
    else { throw VaultError.invalidItem("invalid card bounds") }
  }

  public func validate() throws {
    try validateLimits()
    guard number.utf8.allSatisfy({ (48...57).contains($0) }),
      cvc.utf8.allSatisfy({ (48...57).contains($0) })
    else { throw VaultError.invalidItem("invalid card digits") }
    let sum = number.utf8.reversed().enumerated().reduce(0) { sum, pair in
      let digit = Int(pair.element - 48) * (pair.offset % 2 == 1 ? 2 : 1)
      return sum + (digit > 9 ? digit - 9 : digit)
    }
    guard sum % 10 == 0 else { throw VaultError.invalidItem("invalid card checksum") }
  }
}

public struct CardItem: Sendable {
  public let id: String
  public var draft: CardDraft
  public internal(set) var createdAt: Int64
  public internal(set) var updatedAt: Int64
  public internal(set) var revision: Int64
  public var lastFour: String { String(draft.number.suffix(4)) }
  public var brand: String {
    let number = draft.number
    let two = Int(number.prefix(2)) ?? 0
    let three = Int(number.prefix(3)) ?? 0
    let four = Int(number.prefix(4)) ?? 0
    if number.hasPrefix("4") { return "Visa" }
    if (51...55).contains(two) || (2221...2720).contains(four) { return "Mastercard" }
    if two == 34 || two == 37 { return "American Express" }
    let six = Int(number.prefix(6)) ?? 0
    if four == 6011 || two == 65 || (644...649).contains(three) || (622126...622925).contains(six) { return "Discover" }
    if (300...305).contains(three) || two == 36 || two == 38 || two == 39 { return "Diners Club" }
    if (3528...3589).contains(four) { return "JCB" }
    if two == 62 { return "UnionPay" }
    return "Unknown"
  }

  init(id: String, draft: CardDraft, createdAt: Int64, updatedAt: Int64, revision: Int64) {
    self.id = id
    self.draft = draft
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.revision = revision
  }

  var json: JSONValue {
    .object(["v": .integer(3), "kind": .string("card"), "id": .string(id),
      "createdAt": .integer(createdAt), "updatedAt": .integer(updatedAt),
      "number": .string(draft.number), "expiryMonth": .integer(draft.expiryMonth),
      "expiryYear": .integer(draft.expiryYear), "cvc": .string(draft.cvc),
      "name": draft.name.map(JSONValue.string) ?? .null,
      "label": draft.label.map(JSONValue.string) ?? .null,
      "postalCode": draft.postalCode.map(JSONValue.string) ?? .null])
  }

  init(json: JSONValue, revision: Int64) throws {
    let object = try StrictObject(json, keys: ["v", "kind", "id", "createdAt", "updatedAt",
      "number", "expiryMonth", "expiryYear", "cvc", "name", "label", "postalCode"], context: "card")
    guard try object.integer("v") == 3, try object.string("kind") == "card" else {
      throw VaultError.invalidItem("invalid card kind")
    }
    id = try object.string("id")
    createdAt = try object.integer("createdAt")
    updatedAt = try object.integer("updatedAt")
    self.revision = revision
    draft = CardDraft(number: try object.string("number"), expiryMonth: try object.integer("expiryMonth"),
      expiryYear: try object.integer("expiryYear"), cvc: try object.string("cvc"),
      name: try object.optionalString("name"), label: try object.optionalString("label"),
      postalCode: try object.optionalString("postalCode"))
    try draft.validateLimits()
    guard VaultIDs.isUUID(id), createdAt >= 0, updatedAt >= createdAt else {
      throw VaultError.invalidItem("invalid card identity")
    }
  }
}

enum VaultItem {
  case login(Item)
  case card(CardItem)
  var id: String {
    switch self { case .login(let item): return item.id; case .card(let item): return item.id }
  }
}
