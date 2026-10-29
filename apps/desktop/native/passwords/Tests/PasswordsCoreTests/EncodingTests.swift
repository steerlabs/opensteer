import XCTest
@testable import PasswordsCore

final class EncodingTests: XCTestCase {
  func testBase64URLStrict() {
    // RFC 4648 §10 vectors, unpadded and URL-safe.
    let vectors = ["": "", "f": "Zg", "fo": "Zm8", "foo": "Zm9v", "foob": "Zm9vYg", "fooba": "Zm9vYmE", "foobar": "Zm9vYmFy"]
    for (plain, encoded) in vectors {
      XCTAssertEqual(Base64URL.encode(Data(plain.utf8)), encoded)
      XCTAssertEqual(Base64URL.decode(encoded), Data(plain.utf8))
    }
    XCTAssertEqual(Base64URL.encode(Data([0xFB, 0xFF, 0xBF])), "-_-_")
    XCTAssertEqual(Base64URL.decode("-_-_"), Data([0xFB, 0xFF, 0xBF]))
    for invalid in ["Zg==", "Zm8=", "+/+/", "Zh", "Zm9", "Z", "Zm 9v", "Zm9v\n", "Zm9vY"] {
      XCTAssertNil(Base64URL.decode(invalid), invalid)
    }
    for length in 0..<70 {
      let data = Data((0..<length).map { _ in UInt8.random(in: 0...255) })
      XCTAssertEqual(Base64URL.decode(Base64URL.encode(data)), data)
    }
  }

  func testHex() {
    XCTAssertEqual(Hex.encode([0x00, 0xAB, 0xFF]), "00abff")
    XCTAssertEqual(Hex.decode("00abff"), Data([0x00, 0xAB, 0xFF]))
    XCTAssertNil(Hex.decode("00ABFF"))
    XCTAssertNil(Hex.decode("abc"))
    XCTAssertNil(Hex.decode("zz"))
    XCTAssertEqual(Hex.sha256(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }

  func testBase32() {
    // RFC 4648 §10.
    let vectors = ["f": "MY", "fo": "MZXQ", "foo": "MZXW6", "foob": "MZXW6YQ", "fooba": "MZXW6YTB", "foobar": "MZXW6YTBOI"]
    for (plain, encoded) in vectors {
      XCTAssertEqual(Base32.encode(Data(plain.utf8)), encoded)
      XCTAssertEqual(Base32.decode(encoded), Data(plain.utf8))
      XCTAssertEqual(Base32.decode(encoded.lowercased()), Data(plain.utf8))
    }
    XCTAssertEqual(Base32.decode("MY======"), Data("f".utf8))
    XCTAssertEqual(Base32.decode("MZXW6YQ="), Data("foob".utf8))
    for invalid in ["M", "MZX", "MZXW6Y", "MY=====", "MY=======", "M=Y=====", "MY1", "MY======MY", ""] {
      XCTAssertNil(Base32.decode(invalid), invalid)
    }
  }
}
