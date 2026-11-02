import Foundation

struct RemoteInputTraits: Equatable {
  let editable: Bool
  let sensitive: Bool
  let inputMode: String
  let enterKeyHint: String
  let autocapitalize: String
  let showsKeyboard: Bool

  init(_ context: [String: Any]?, softKeyboard: Bool) {
    let field = context?["field"] as? [String: Any]
    editable = field != nil
    sensitive = field?["sensitive"] as? Bool == true
    let mode = field?["inputMode"] as? String ?? ""
    inputMode = ["numeric", "decimal", "tel", "email", "url", "search"].contains(mode) ? mode : "text"
    let hint = field?["enterKeyHint"] as? String ?? ""
    enterKeyHint = ["done", "go", "next", "search", "send"].contains(hint) ? hint : ""
    let capitalization = field?["autocapitalize"] as? String ?? ""
    autocapitalize = capitalization == "on" ? "sentences" :
      (["sentences", "words", "characters"].contains(capitalization) ? capitalization : "none")
    showsKeyboard = editable && softKeyboard && mode != "none"
  }
}
