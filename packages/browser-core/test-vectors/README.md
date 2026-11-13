# Phone browser wire vectors

These JSON fixtures use format version 1 independently of the browser runtime wire version;
attach tickets carry wire version 2 and are shared with Swift and Kotlin, not generated on a phone.
TypeScript, Swift and Kotlin each test their production code against these files. They are the only
check that the phones' native allowlists still match the protocol, so change a field name on every side.

`attach-tickets.v1.json` has a disposable public key, exact compact JWS bytes, a fixed verification
time and each expected admission outcome. It contains no private key. Verification must reject
noncanonical base64url before trusting the claims; durable nonce admission precedes allocation.
Its `every-phone-claim` case carries every claim the Host can issue to a phone browser, and
`src/portable.test.ts` writes the file from the strict claims schema.

`phone-descriptors.v1.json` is the browser module each phone advertises, written from
`apps/mobile/src/phone-browser/descriptor.ts` and read in full by the Host's runner schema. The
iPhone admits it natively; Android builds it natively. Run either writer with
`OPENSTEER_WRITE_PHONE_VECTORS=1` to regenerate.

`frames.v1.json` has hex bytes for the four-byte big-endian JSON-length envelope, and the relay
envelope wrapping that whole frame. The JPEG marker payload tests framing, not image decoding.
JSON key order is not an admission rule. Decode the exact bytes, including nonzero-offset views,
and validate both headers before exposing the payload.

`fences.v1.json` has the auxiliary welcome/fence, replacement comparisons and ordered replay-ledger
transitions. Apply replay cases in order; a refused transition leaves the preceding state intact.
Fence equality does not replace lease expiry: an equal fence on an expired stream cannot send.
The Node-free test in `src/portable.test.ts` consumes the ticket, frame and fence files.
