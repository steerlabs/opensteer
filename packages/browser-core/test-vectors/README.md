# Phone browser wire vectors

These version-1 JSON fixtures are shared with Swift and Kotlin, not generated on a phone.
`attach-tickets.v1.json` has a disposable public key, exact compact JWS bytes, a fixed verification
time and each expected admission outcome. It contains no private key. Verification must reject
noncanonical base64url before trusting the claims; durable nonce admission precedes allocation.

`frames.v1.json` has hex bytes for the four-byte big-endian JSON-length envelope, and the relay
envelope wrapping that whole frame. The JPEG marker payload tests framing, not image decoding.
JSON key order is not an admission rule. Decode the exact bytes, including nonzero-offset views,
and validate both headers before exposing the payload.

`fences.v1.json` has the auxiliary welcome/fence, replacement comparisons and ordered replay-ledger
transitions. Apply replay cases in order; a refused transition leaves the preceding state intact.
Fence equality does not replace lease expiry: an equal fence on an expired stream cannot send.
The Node-free test in `src/portable.test.ts` consumes all three files.
