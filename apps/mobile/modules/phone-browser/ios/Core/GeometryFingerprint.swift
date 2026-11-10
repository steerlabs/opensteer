import Foundation

/// What a page's geometry revision follows: its size, zoom, insets and keyboard. Scrolling, and
/// WebKit's visual viewport sliding over the layout viewport as it scrolls and bounces, move the
/// page under unchanged coordinates, as on the Mac, so they are reported but not counted.
public enum GeometryFingerprint {
  public static func of(_ geometry: [String: Any]) -> NSDictionary {
    var layout = geometry
    layout.removeValue(forKey: "scroll")
    layout.removeValue(forKey: "offset")
    return layout as NSDictionary
  }
}
