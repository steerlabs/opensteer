import Foundation

/// One day on a calendar, with no time and no zone: an all-day event's day,
/// or a reminder due on a day rather than at a time.
public struct DataDay: Hashable, Comparable, Sendable {
  public let year: Int
  public let month: Int
  public let day: Int

  public init(year: Int, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }

  public static func < (lhs: DataDay, rhs: DataDay) -> Bool {
    (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
  }
}

/// The device clock, as Calendar and Reminders read and write times: the
/// Gregorian calendar whatever calendar the person reads dates in, in the zone
/// device is set to. A time an agent gives without an offset is this clock's
/// wall time; a time the helper gives always carries the offset in force then.
public struct DataClock: Sendable {
  public enum Moment: Equatable, Sendable {
    case day(DataDay)
    case instant(Date)
  }

  /// The zone follows the device setting as it changes.
  public static let mac = DataClock(timeZone: .autoupdatingCurrent)
  public static let iphone = DataClock(timeZone: .autoupdatingCurrent, deviceName: "iPhone")

  public let timeZone: TimeZone
  public let deviceName: String

  public init(timeZone: TimeZone, deviceName: String = "Mac") {
    self.timeZone = timeZone
    self.deviceName = deviceName
  }

  var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar
  }

  /// Built per parse: a `Regex` is not `Sendable`, and parses are few.
  private static var pattern: Regex<AnyRegexOutput> {
    try! Regex(
      #"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$"#
    )
  }

  /// `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional `Z` or
  /// `±HH:MM`. A wall time this clock skips for daylight saving is refused
  /// rather than moved; one it passes twice is the first.
  public func moment(_ text: String, field: String) throws -> Moment {
    let unreadable = HelperError(
      .failed,
      "\(field) must be a date (YYYY-MM-DD) or a time (YYYY-MM-DDTHH:MM, with an optional offset such as -07:00)."
    )
    guard let match = try? Self.pattern.wholeMatch(in: text) else { throw unreadable }
    func number(_ index: Int) -> Int? {
      match.output[index].substring.flatMap { Int($0) }
    }
    guard let year = number(1), let month = number(2), let day = number(3) else {
      throw unreadable
    }
    let date = DataDay(year: year, month: month, day: day)
    guard exists(date) else { throw HelperError(.failed, "\(field) is not a real date.") }
    guard let hour = number(4), let minute = number(5) else { return .day(date) }
    let second = number(6) ?? 0
    guard (0...23).contains(hour), (0...59).contains(minute), (0...59).contains(second) else {
      throw unreadable
    }
    let fraction = match.output[7].substring.map { Double("0.\($0)") ?? 0 } ?? 0

    var components = DateComponents(
      year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    var zone = timeZone
    if let offset = match.output[8].substring {
      guard let fixed = Self.zone(offset: String(offset)) else { throw unreadable }
      zone = fixed
    }
    var calendar = calendar
    calendar.timeZone = zone
    components.timeZone = zone
    guard
      let resolved = calendar.date(from: components),
      calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: resolved)
        == DateComponents(
          year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    else {
      throw HelperError(
        .failed,
        "\(field) names \(String(format: "%02d:%02d", hour, minute)) on \(text.prefix(10)), which this \(deviceName)'s clock skips for daylight saving time."
      )
    }
    return .instant(resolved.addingTimeInterval(fraction))
  }

  private static func zone(offset: String) -> TimeZone? {
    if offset == "Z" { return TimeZone(secondsFromGMT: 0) }
    let sign = offset.hasPrefix("-") ? -1 : 1
    let parts = offset.dropFirst().split(separator: ":")
    guard parts.count == 2, let hours = Int(parts[0]), let minutes = Int(parts[1]),
      hours <= 18, minutes <= 59
    else { return nil }
    return TimeZone(secondsFromGMT: sign * (hours * 3600 + minutes * 60))
  }

  private func exists(_ day: DataDay) -> Bool {
    guard let date = calendar.date(from: components(day)) else { return false }
    return self.day(of: date) == day
  }

  private func components(_ day: DataDay) -> DateComponents {
    DateComponents(year: day.year, month: day.month, day: day.day)
  }

  /// The first instant of `day` on this clock.
  public func startOfDay(_ day: DataDay) -> Date {
    calendar.startOfDay(for: calendar.date(from: components(day)) ?? Date(timeIntervalSince1970: 0))
  }

  public func day(of date: Date) -> DataDay {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    return DataDay(year: components.year ?? 1, month: components.month ?? 1, day: components.day ?? 1)
  }

  public func adding(days: Int, to day: DataDay) -> DataDay {
    guard let moved = calendar.date(byAdding: .day, value: days, to: startOfDay(day)) else {
      return day
    }
    return self.day(of: moved)
  }

  public func days(from start: DataDay, to end: DataDay) -> Int {
    calendar.dateComponents([.day], from: startOfDay(start), to: startOfDay(end)).day ?? 0
  }

  /// `YYYY-MM-DDTHH:MM:SS` and the offset in force at that instant.
  public func text(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    let stamp = String(
      format: "%04d-%02d-%02dT%02d:%02d:%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
      parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    let offset = timeZone.secondsFromGMT(for: date)
    guard offset != 0 else { return stamp + "Z" }
    let minutes = abs(offset) / 60
    return stamp + String(format: "%@%02d:%02d", offset < 0 ? "-" : "+", minutes / 60, minutes % 60)
  }

  public func text(_ day: DataDay) -> String {
    String(format: "%04d-%02d-%02d", day.year, day.month, day.day)
  }

  public func text(_ moment: Moment) -> String {
    switch moment {
    case .day(let day): return text(day)
    case .instant(let date): return text(date)
    }
  }
}
