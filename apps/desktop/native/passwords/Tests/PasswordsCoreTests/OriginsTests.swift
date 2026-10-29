import XCTest
@testable import PasswordsCore

/// `Fixtures/origin-fixtures.json` is shared with the TypeScript side, which
/// checks every non-null origin against the WHATWG URL parser.
final class OriginsTests: XCTestCase {
  private struct OriginFixture: Decodable {
    let input: String
    let origin: String?
  }

  func testOriginFixtures() throws {
    let fixtures = try JSONDecoder().decode([OriginFixture].self, from: try fixtureData("origin-fixtures.json"))
    XCTAssertGreaterThan(fixtures.count, 50)
    for fixture in fixtures {
      XCTAssertEqual(Origins.normalizeOrigin(fixture.input), fixture.origin, fixture.input.debugDescription)
    }
  }

  func testIDNMappingRejected() {
    // UTS46 maps or drops these; the typed host would not be what is stored.
    XCTAssertNil(Origins.normalizeOrigin("https://exa\u{200B}mple.com/"))
    XCTAssertNil(Origins.normalizeOrigin("https://\u{FF21}bc.example.com/"))
    XCTAssertNil(Origins.normalizeOrigin("https://\u{1E9E}.example/"))
    XCTAssertNil(Origins.normalizeOrigin("https://B\u{DC}CHER.example/"))
    // NFC is part of UTS46 and WHATWG applies it too.
    XCTAssertEqual(Origins.normalizeOrigin("https://bu\u{0308}cher.example/"), "https://xn--bcher-kva.example")
  }

  /// O13: an `xn--` label must be exactly what the strict Unicode path
  /// produces for the text it decodes to, as UTS46 requires. Otherwise
  /// labels every browser refuses (controls, bidi overrides, upper case,
  /// non-NFC, dot lookalikes, a lone joiner, unassigned code points) became
  /// origins. (Second review, finding 5.)
  func testInvalidACELabelsRefused() throws {
    for (name, unicode) in [
      ("C1 control", "\u{80}"), ("right-to-left override", "lapyap\u{202E}evil"), ("upper case", "\u{C4}pple"),
      ("not NFC", "ba\u{308}cher"), ("one dot leader", "paypal\u{2024}com"), ("fullwidth full stop", "paypal\u{FF0E}com"),
      ("lone zero width joiner", "pay\u{200D}pal"), ("unassigned", "a\u{378}"), ("noncharacter", "a\u{FFFF}"),
    ] {
      let label = "xn--" + (try XCTUnwrap(Punycode.encode(unicode), name))
      XCTAssertNil(Origins.normalizeOrigin("https://\(label).example.com/"), name)
      XCTAssertNil(Origins.normalizeOrigin("https://\(label).com/"), name)
    }
    XCTAssertEqual(Origins.normalizeOrigin("https://xn--bcher-kva.example/"), "https://xn--bcher-kva.example")
    XCTAssertEqual(Origins.normalizeOrigin("https://xn--pple-43d.com/"), "https://xn--pple-43d.com")
    XCTAssertEqual(Origins.normalizeOrigin("https://xn--zca.example/"), "https://xn--zca.example")
  }

  /// The second review's spot checks: refused inputs stay refused, lookalikes
  /// get their own site, and wildcard and exception rules hold.
  func testReviewSpotChecks() {
    let refused = [
      "https://example.com.", "https://example.com..", "https://exa%6Dple.com", "https://user@example.com",
      "https://example.com:443@evil.com", "https://127.0.0.1", "https://0x7f.1", "https://example.0x",
      "https://[::1]", "https://localhost", "https://a.localhost", "https://com", "https://co.uk", "https://github.io",
      "https://ex\u{3002}ample.com", "https://example\u{FF0E}com", "https://ex\u{FF20}mple.com", "https://a\u{2024}com",
      "https://\u{24D0}pple.com", "https://xn--pple-43d.com\u{200D}", "https://e\u{0301}xample.com\u{FE0F}",
      "https://xn--nxasmq6b.com".uppercased() + "\u{0000}", "https:example.com", "https:/example.com", "https:///example.com",
      "https://example.com\t/", "https://example.com\\@evil.com", "https://" + String(repeating: "a", count: 64) + ".com",
      "https://-a.example.com", "https://a-.example.com", "https://xn--.com",
      "https://example.com:00443", "https://example.com:+443", "https://example.com: 443",
    ]
    for input in refused {
      XCTAssertNil(Origins.normalizeOrigin(input), input.debugDescription)
    }
    // Lookalikes get their own punycode site, never the real one.
    let cyrillic = Origins.normalizeOrigin("https://\u{0430}pple.com")
    XCTAssertEqual(cyrillic, "https://xn--pple-43d.com")
    XCTAssertFalse(Origins.isWithinSite(cyrillic ?? "", site: "https://apple.com"))
    XCTAssertFalse(Origins.isWithinSite("https://apple.com", site: "https://xn--pple-43d.com"))
    // Wildcard and exception rules.
    XCTAssertEqual(Origins.registrableDomain("a.b.c.kobe.jp"), "b.c.kobe.jp")
    XCTAssertEqual(Origins.registrableDomain("www.city.kobe.jp"), "city.kobe.jp")
    XCTAssertEqual(Origins.registrableDomain("www.ck"), "www.ck")
    XCTAssertNil(Origins.registrableDomain("foo.ck"))
    XCTAssertFalse(Origins.isWithinSite("https://a.foo.ck", site: "https://b.foo.ck"))
    XCTAssertFalse(Origins.isWithinSite("https://victim.blogspot.com", site: "https://blogspot.com"))
    // Unknown TLDs and mDNS names fall under the PSL default rule.
    XCTAssertEqual(Origins.normalizeOrigin("https://nas.local"), "https://nas.local")
    XCTAssertEqual(Origins.normalizeOrigin("https://router.home.arpa"), "https://router.home.arpa")
    XCTAssertEqual(Origins.normalizeOrigin("https://printer.internal"), "https://printer.internal")
  }

  func testLoginURL() {
    XCTAssertEqual(Origins.normalizeLoginURL("https://Example.com"), "https://example.com/")
    XCTAssertEqual(Origins.normalizeLoginURL("https://example.com:443/a/b?c=d&e=f#frag"), "https://example.com/a/b?c=d&e=f")
    XCTAssertEqual(Origins.normalizeLoginURL("https://example.com:8443?x"), "https://example.com:8443/?x")
    XCTAssertEqual(Origins.normalizeLoginURL("https://example.com/p\u{E4}th?q=\u{FC}"), "https://example.com/p%C3%A4th?q=%C3%BC")
    XCTAssertEqual(Origins.normalizeLoginURL("https://example.com/a%2Fb?x=%41"), "https://example.com/a%2Fb?x=%41")
    XCTAssertEqual(Origins.normalizeLoginURL("https://example.com/{x}?q='"), "https://example.com/%7Bx%7D?q=%27")
    XCTAssertNil(Origins.normalizeLoginURL("https://example.com/a/../b"))
    XCTAssertNil(Origins.normalizeLoginURL("https://example.com/./b"))
    XCTAssertNil(Origins.normalizeLoginURL("https://example.com/%2e%2E/b"))
    XCTAssertNil(Origins.normalizeLoginURL("https://example.com/%zz"))
    XCTAssertNil(Origins.normalizeLoginURL("http://example.com/login"))
  }
}

/// `Fixtures/site-fixtures.json` was generated from tldts 6.1.86 with
/// `allowPrivateDomains: true`; the TypeScript side validates it again.
final class SiteTests: XCTestCase {
  private struct SiteFixture: Decodable {
    let host: String
    let registrableDomain: String?
  }

  func testBundledListLoads() throws {
    let list = try XCTUnwrap(PublicSuffixList.bundled)
    XCTAssertEqual(list.ruleCount, 9_759)
  }

  func testSiteFixtures() throws {
    let fixtures = try JSONDecoder().decode([SiteFixture].self, from: try fixtureData("site-fixtures.json"))
    XCTAssertGreaterThan(fixtures.count, 50)
    for fixture in fixtures {
      XCTAssertEqual(Origins.registrableDomain(fixture.host), fixture.registrableDomain, fixture.host)
    }
  }

  /// Where an explicit rule sits under a wildcard (`*.futurecms.at` and
  /// `*.ex.futurecms.at`), the PSL algorithm makes `ex.futurecms.at` a
  /// public suffix. tldts 6.1.86 instead answers `futurecms.at` for these
  /// eight hosts, so they stay out of the shared fixture. Refusing them is
  /// the fail-closed side: no origin, no password released.
  func testWildcardSiblingsFollowThePSLAlgorithm() {
    let hosts = [
      "ex.futurecms.at", "in.futurecms.at", "oci.customer-oci.com", "ocp.customer-oci.com", "ocs.customer-oci.com",
      "sub.wc.psl.hrsn.dev", "privatelink.snowflake.app", "svc.firenet.ch",
    ]
    for host in hosts {
      XCTAssertNil(Origins.registrableDomain(host), host)
      XCTAssertNil(Origins.normalizeOrigin("https://\(host)/"), host)
    }
    XCTAssertEqual(Origins.registrableDomain("tenant.ex.futurecms.at.example"), "at.example")
    XCTAssertEqual(Origins.registrableDomain("a.b.ex.futurecms.at"), "a.b.ex.futurecms.at")
    XCTAssertEqual(Origins.registrableDomain("ignored.wc.psl.hrsn.dev"), "ignored.wc.psl.hrsn.dev")
  }

  func testWithinSite() {
    XCTAssertTrue(Origins.isWithinSite("https://example.com", site: "https://example.com"))
    XCTAssertTrue(Origins.isWithinSite("https://login.example.com:8443", site: "https://example.com"))
    XCTAssertTrue(Origins.isWithinSite("https://a.b.example.co.uk", site: "https://example.co.uk"))
    XCTAssertTrue(Origins.isWithinSite("https://bucket.s3.amazonaws.com", site: "https://bucket.s3.amazonaws.com"))
    XCTAssertFalse(Origins.isWithinSite("https://bucket.s3.amazonaws.com", site: "https://amazonaws.com"))
    XCTAssertFalse(Origins.isWithinSite("https://alice.github.io", site: "https://bob.github.io"))
    XCTAssertFalse(Origins.isWithinSite("https://evil-example.com", site: "https://example.com"))
    XCTAssertFalse(Origins.isWithinSite("https://example.com.evil.example", site: "https://example.com"))
    XCTAssertFalse(Origins.isWithinSite("https://login.example.com", site: "https://login.example.com"))
    XCTAssertFalse(Origins.isWithinSite("http://example.com", site: "https://example.com"))
    XCTAssertFalse(Origins.isWithinSite("https://example.com", site: "https://example.com:8443"))
    XCTAssertFalse(Origins.isWithinSite("https://example.com", site: "https://co.uk"))
  }

  /// RFC 3492 §7.1 samples (lower-cased).
  func testPunycode() {
    let samples = [
      ("\u{0644}\u{064A}\u{0647}\u{0645}\u{0627}\u{0628}\u{062A}\u{0643}\u{0644}\u{0645}\u{0648}\u{0634}\u{0639}\u{0631}\u{0628}\u{064A}\u{061F}", "egbpdaj6bu4bxfgehfvwxn"),
      ("\u{4ED6}\u{4EEC}\u{4E3A}\u{4EC0}\u{4E48}\u{4E0D}\u{8BF4}\u{4E2D}\u{6587}", "ihqwcrb4cv8a8dqg056pqjye"),
      ("3\u{5E74}B\u{7D44}\u{91D1}\u{516B}\u{5148}\u{751F}", "3B-ww4c5e180e575a65lsy2b"),
      ("bücher", "bcher-kva"),
      ("пример", "e1afmkfd"),
    ]
    for (unicode, encoded) in samples {
      XCTAssertEqual(Punycode.encode(unicode), encoded)
      XCTAssertEqual(Punycode.decode(encoded).map { Array($0.unicodeScalars) }, Array(unicode.unicodeScalars))
    }
    XCTAssertNil(Punycode.decode("bcher-kv!"))
    XCTAssertNil(Hosts.decodedIDNLabel("xn--abc-"))
    XCTAssertNil(Hosts.decodedIDNLabel("xn--BCHER-KVA"))
    XCTAssertEqual(Hosts.decodedIDNLabel("xn--bcher-kva"), "bücher")
  }
}
