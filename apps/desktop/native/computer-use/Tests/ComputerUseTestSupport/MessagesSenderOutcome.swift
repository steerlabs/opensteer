import Foundation

@testable import ComputerUseCore

func messagesSendOutcome(_ ending: OsascriptOutcome) -> HelperError? {
  do {
    try MessagesSender.check(ending)
    return nil
  } catch {
    return error as? HelperError
  }
}
