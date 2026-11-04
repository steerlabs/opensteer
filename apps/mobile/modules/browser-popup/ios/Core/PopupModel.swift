import Foundation

struct PopupFence {
  private(set) var id: String?
  private(set) var revision: String?
  mutating func present(_ id: String, _ revision: String) { self.id = id; self.revision = revision }
  mutating func dismiss(_ id: String) { if self.id == id { self.id = nil; revision = nil } }
  func accept(_ id: String, _ revision: String) -> Bool { self.id == id && self.revision == revision }
}
struct PopupItem: Decodable {
  let id: String, kind: String, label: String
  let groupId: String?, secondaryLabel: String?
  let enabled: Bool, selected: Bool, rtl: Bool, directionOverride: Bool
}
struct PopupModel: Decodable {
  let kind: String, rtl: Bool, items: [PopupItem]
  let notice: String?
  let multiple: Bool?, value: String?, alpha: Bool?, colorSpace: String?
  let minimum: Double?, maximum: Double?, step: Double?, stepBase: Double?, stepAny: Bool?, required: Bool?
}
struct PopupCalendar {
  struct Parts {
    var year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0, week = 1
    var fraction = ""
    func value(_ kind: String) -> String {
      let date = String(format: "%04d-%02d-%02d", year, month, day)
      let time = String(format: "%02d:%02d:%02d", hour, minute, second) + fraction
      switch kind { case "date": return date; case "time": return time; case "month": return String(format: "%04d-%02d", year, month); case "week": return String(format: "%04d-W%02d", year, week); default: return date + "T" + time }
    }
  }
  static var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(secondsFromGMT: 0)!; c.locale = Locale(identifier: "en_US_POSIX"); return c }
  static func parts(_ value: String, kind: String) -> Parts? {
    let pattern: String
    switch kind {
      case "date": pattern = "^(\\d{4,})-(\\d{2})-(\\d{2})$"
      case "month": pattern = "^(\\d{4,})-(\\d{2})$"
      case "week": pattern = "^(\\d{4,})-W(\\d{2})$"
      case "time": pattern = "^(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,3})?)?$"
      default: pattern = "^(\\d{4,})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,3})?)?$"
    }
    guard value.utf8.count <= 4096, let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return nil }
    func text(_ i: Int) -> String { guard i < match.numberOfRanges, let r = Range(match.range(at: i), in: value) else { return "" }; return String(value[r]) }
    func number(_ i: Int, _ fallback: Int = 0) -> Int { Int(text(i)) ?? fallback }
    var p = Parts()
    if kind == "time" { p.hour = number(1); p.minute = number(2); p.second = number(3); p.fraction = text(4) }
    else {
      p.year = number(1); guard p.year > 0 && p.year <= 275760 else { return nil }
      if kind == "week" {
        p.week = number(2)
        let leap = p.year % 4 == 0 && (p.year % 100 != 0 || p.year % 400 == 0)
        let before = p.year - 1
        let jan1 = (before + before/4 - before/100 + before/400 + 1) % 7
        let maxWeek = jan1 == 4 || (jan1 == 3 && leap) ? 53 : 52
        return p.week >= 1 && p.week <= maxWeek ? p : nil
      }
      p.month = number(2); p.day = kind == "month" ? 1 : number(3)
      if kind == "datetime-local" { p.hour = number(4); p.minute = number(5); p.second = number(6); p.fraction = text(7) }
      let leap = p.year % 4 == 0 && (p.year % 100 != 0 || p.year % 400 == 0)
      let monthDays = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31]
      guard (1...12).contains(p.month), p.day >= 1 && p.day <= monthDays[p.month-1] else { return nil }
    }
    guard p.hour < 24 && p.minute < 60 && p.second < 60 else { return nil }
    return p
  }
}

struct PopupKeyReleases {
  private var local = Set<Int>()
  private var forwarded = Set<Int>()
  mutating func began(_ code: Int) { if local.count < 128 { local.insert(code) } }
  mutating func ended(_ code: Int) -> Bool {
    if local.remove(code) != nil { return false }
    guard forwarded.count < 128 else { return false }
    return forwarded.insert(code).inserted
  }
}
