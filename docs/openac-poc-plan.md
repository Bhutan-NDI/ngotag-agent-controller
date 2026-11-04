# OpenAC × Agent Controller — Workshop PoC Plan

Nov 4, 2026 · @Kinzang Dorji

> **Revision 2 (Nov 4, 2026).** The SDK is now taken from npm (`openac-sdk@5.0.0`, pinned) and patched with `patch-package`, instead of building a zkID fork and vendoring a tarball. Step 1, the checklist, the troubleshooting table and the limitations table changed; nothing else did.

> **Revision 3 (Nov 4, 2026).** Verification against the real code and circuits changed three things: the Age credential’s second claim is `country_of_residence` (Credo’s 16-character salts make short disclosures fail the `1k` Prepare circuit), `birth_ymd` must be a string, and the SDK patch also fixes the witness-calculator loader. See “OpenAC PoC — Step 0 verification findings” in this project.

## Purpose and scope

The PoC proves one thing: the NGOTAG agent controller can issue an SD-JWT credential, hold it, and produce and verify an OpenAC zero-knowledge proof that a citizen is 18 or older without revealing the birth date.

All three roles (issuer, holder, verifier) run on the agent controller as separate tenants. NDI already uses the agent controller as a cloud wallet for holders, so the cloud holder is a real deployment path, not a stand-in, and it lets us test the full flow end to end. Mobile wallet proving is being built in parallel by a separate developer.

**In scope**

- One credential type: a compact “Age credential” with two claims, issued over OID4VCI as `dc+sd-jwt`, signed ES256 by a P-256 `did:key`
- Holder key binding with a P-256 key in `cnf.jwk`, kept in Askar
- OpenAC Prepare, Show and Verify using `openac-sdk`, exposed as controller endpoints
- One predicate: `birth_date <= today minus 18 years`
- A live demo plus a simple-language explanation for the workshop

**Out of scope**

- Mobile wallet proving in this plan; a separate developer builds it in parallel against the same issuer and verifier endpoints
- Revocation (the PoC uses short credential expiry instead)
- Nullifiers / one-person-one-account
- OID4VP or DIDComm transport for OpenAC proofs (the PoC uses plain REST calls)
- Production hardening, audience binding, performance tuning

## OpenAC explained simply

OpenAC lets a citizen answer a question about their credential (“Are you over 18?”) with a mathematical proof, instead of showing the credential.

**The analogy.** Today, proving age at a bar means handing over an ID card. The bouncer sees your name, CID number and exact birth date, and could photocopy it. With OpenAC, you hand over a sealed note that says “the person holding a genuine NDI card is over 18”. The bouncer can check the note is genuine, but learns nothing else, and two bouncers comparing notes cannot tell they saw the same person.

**The three steps**

1. **Prepare (once per credential, slow, about 2 seconds on a phone).** The holder’s software checks the issuer’s signature and locks the credential’s values into a hidden commitment. Think of it as sealing the ID card into a tamper-proof envelope.
2. **Show (every time a verifier asks, fast, under 100 ms on a phone).** The verifier sends a random challenge and a question. The holder proves the answer from inside the envelope and signs the challenge with their device key, so the proof is fresh and cannot be replayed.
3. **Verify (verifier side, milliseconds).** The verifier checks the proof maths, checks it answers its own question with its own challenge, and checks the issuer is one it trusts.

**Key terms**

| Term | Plain meaning |
| --- | --- |
| Zero-knowledge proof | A proof that a statement is true which reveals nothing beyond that fact |
| Predicate | The yes/no question, e.g. `birth_date <= 2008-11-04` |
| SD-JWT VC | The credential format OpenAC reads; a signed JSON token with selectively disclosable claims |
| ES256 / P-256 | The signature algorithm and curve OpenAC supports; issuer and holder keys must both use it |
| Device binding (`cnf.jwk`) | The holder’s public key written into the credential, so only the key owner can present it |
| Nonce / challenge | A random value from the verifier that makes each proof single-use |
| Unlinkability | Two presentations of the same credential look unrelated to verifiers |

One honest caveat for the audience: the issuer still knows which device key belongs to which citizen, because it wrote `cnf.jwk` at issuance. OpenAC hides the citizen from verifiers, not from the issuer.

## What the integration achieves

The integration adds a privacy layer on top of NDI’s existing issuance: verifiers get answers instead of data, with no change to how issuers sign.

| Today with NDI | With OpenAC |
| --- | --- |
| Verifier receives disclosed claims (e.g. full birth date) | Verifier receives only “true” or “false” for its question |
| Signature and holder key are the same in every presentation, so verifiers can correlate a citizen | Each proof is re-randomised; verifiers cannot link presentations |
| Predicates need custom logic on the verifier | Predicates (`>=`, `<=`, `==`, `all`, `any`, `not`) are proved by the holder |
| Strong privacy would need new issuer cryptography (e.g. BBS+) | Issuers keep standard ES256, compatible with existing HSMs and OID4VCI |

**Example uses for Bhutan NDI**

- Age gates (alcohol, tobacco, online services) without sharing date of birth or CID
- “Is a Bhutanese citizen” or “resides in Dzongkhag X” checks without revealing identity
- Eligibility checks such as “income below threshold” for subsidies, using claim-to-claim comparisons
- Later, with nullifiers: one account per citizen per service, without the service knowing who the citizen is

For the workshop, the message is simple: the same credential NDI already knows how to issue can answer questions privately.

## Architecture of the PoC

Everything runs on one agent controller instance: issuer, holder and verifier are separate tenants, and the only new code is one OpenAC module plus a small `patch-package` patch to the published SDK.

&#91;embedded content: PoC architecture · three tenants, one new module\]

The issuer uses existing endpoints unchanged. The holder tenant is the cloud wallet NDI already runs; the mobile wallet will call the same issuer and verifier endpoints. All OpenAC logic (challenge, precompute, present, verify) sits in the new module.

## Implementation plan

The build is six steps: one small patch to the published SDK, configuration through existing controller endpoints, and one new `OpenAcController` with four routes.

### Step 1. Install and patch openac-sdk

Use the published package, not a fork: `openac-sdk@5.0.0` on npm (repository `privacy-scaling-explorations/zkID`). Pin it to exactly `5.0.0`, with no caret, because the patch below applies to the compiled bundle and a different build would break it. The controller already runs `patch-package --error-on-fail` in `postinstall`, so the patch is re-applied on every install and a mismatch fails loudly.

The SDK’s `present()` needs the raw device private key, but the holder key lives in Askar and cannot be exported. In 5.0.0, `present()` derives the signature itself (`dist/index.js`, `const deviceSignature = signDeviceNonce(verifierNonce, devicePrivateKey)`). The circuit uses that signature as a witness, so it cannot be swapped after the fact. The SDK only uses the key to sign the verifier nonce, so let `present()` accept a ready-made signature.

```ts
// node_modules/openac-sdk/dist/sizing-*.d.ts — PresentRequest (the file name is hashed)
devicePrivateKey?: EcdsaPrivateKey;
deviceSignature?: string; // base64url raw r||s, low-S

// node_modules/openac-sdk/dist/index.js — present()
const deviceSignature = request.deviceSignature
  ?? signDeviceNonce(verifierNonce, devicePrivateKey);
// if neither deviceSignature nor devicePrivateKey is given, throw an InputError
```

Add a third change to the same patch: the published package ships `assets/witness_calculator.js` as CommonJS inside a `"type": "module"` package, so `WitnessCalculator.init()` fails with `module is not defined` (and `OpenAC.init()` swallows the error). Create `assets/package.json` containing `{"type":"commonjs"}` (verified to fix it).

Edit those files in `node_modules`, then run `yarn patch-package openac-sdk` to write `patches/openac-sdk+5.0.0.patch`. Commit the patch file. Add a Jest test in the controller that proves with a signature made by an ordinary P-256 key (no `devicePrivateKey`) and checks that `verify()` accepts it, and that `present()` throws when neither value is given.

**Keys.** The package bundles only the `show` verifying keys. The four `1k` files (`1k_prepare_proving.key`, `1k_prepare_verifying.key`, `1k_show_proving.key`, `1k_show_verifying.key`) are not bundled; `loadKeysFromUrl` fetches them from the SDK’s default CDN, and the SDK holds a SHA-256 for each file. Download the four `1k` files once, check them against those hashes, and keep them on a controller volume (not in git). Load them from disk with `openac.loadKeys(...)`, or serve them over HTTP and point `keysBaseUrl` at that server, so the demo does not depend on the internet.

**Module format (check first).** `openac-sdk` is ESM-only (its `exports` has only an `import` condition), and the controller compiles to CommonJS (`tsconfig.build.json`: `"module": "commonjs"`). A plain `import` or `require` will fail. Load the SDK with a dynamic `import()` that TypeScript does not rewrite to `require`, and confirm this works in the Docker image’s Node version before building the rest.

### Step 2. Issuer tenant: P-256 DID and issuer config

Create the issuer DID with `POST /dids/write`, `method: "key"`, `keyType: "p256"`. Use a DID, not an x5c chain, because a certificate chain in the JWT header can push the token past the circuit’s message limit (1,280 bytes for the `1k` circuit that the PoC uses).

Create the OID4VC issuer with `POST /openid4vc/issuer`. The binding methods must list only `jwk`; if `did:key` or `did:jwk` appears, the holder binds with `cnf.kid` and OpenAC cannot read it.

```json
"credentialConfigurationsSupported": {
  "AgeCredential-sdjwt": {
    "format": "dc+sd-jwt",
    "vct": "AgeCredential",
    "cryptographic_binding_methods_supported": ["jwk"],
    "credential_signing_alg_values_supported": ["ES256"],
    "proof_types_supported": { "jwt": { "proof_signing_alg_values_supported": ["ES256"] } }
  }
}
```

### Step 3. Issue a compact Age credential

Call `POST /openid4vc/issuance-sessions/create-credential-offer` with `signerOptions: { method: "did", did: "<issuer did:key>" }` and no `statusListDetails`.

```json
"payload": { "vct": "AgeCredential", "birth_ymd": "20000514", "country_of_residence": "BT" },
"disclosureFrame": { "_sd": ["birth_ymd", "country_of_residence"] }
```

The birth date is a `YYYYMMDD` value written as a **string** (`"20000514"`), not an ISO date and not a JSON number: the circuit accepts the string with `format: "uint"` and rejects an unquoted number (verified). The SDK only exposes Taiwan’s ROC calendar for the `date` format, so a decimal string compared with `<=` is the reliable choice. Two circuit limits apply: the credential has at most 2 claims and the verifier at most 2 predicates by default, and **every disclosure must be at least 42 bytes of JSON** (`["salt","key","value"]`). Credo uses 16-character salts, so `len(key) + len(value)` must be at least 16; a short claim such as `country: "BT"` fails Prepare with `Assert Failed`, which is why the second claim is named `country_of_residence`.

### Step 4. Holder tenant: receive and check the credential

Call `POST /openid4vc/holder/resolve-credential-offer`, then `POST /openid4vc/holder/request-credential`. Run `POST /openid4vc/holder/decode-sdjwt` and confirm the payload has `cnf.jwk` with `crv: "P-256"`.

In `credentialBindingResolver.ts`, record the Askar `keyId` of the key it creates (for example in a generic record keyed by the JWK thumbprint). Step 5 needs it to sign nonces.

### Step 5. New `OpenAcController` (`/openac`)

Add `src/controllers/openac/OpenAcController.ts` and an `OpenAcService` that calls `OpenAC.init()` and loads keys once at startup.

| Route | Role | What it does |
| --- | --- | --- |
| `POST /openac/verifier/challenge` | Verifier | Returns a 32-byte random nonce and the policy; stores the nonce with a 2-minute expiry |
| `POST /openac/holder/precompute` | Holder | Loads the SD-JWT record, splits it into JWT and disclosures, resolves the issuer `did:key` to a JWK, runs `precompute()`, caches the result |
| `POST /openac/holder/present` | Holder | Signs the nonce with the Askar key, normalises to low-S, runs `present()`, returns the proof |
| `POST /openac/verifier/verify` | Verifier | Checks the nonce is known, unused and unexpired, deletes it, runs `verify()`, checks the issuer key against its trust list |

Nonce signing in the holder route:

```ts
const { signature } = await kms.sign({ keyId, algorithm: 'ES256',
  data: TypedArrayEncoder.fromString(nonce) });   // raw r||s, 64 bytes
const n = p256.CURVE.n;
let s = bytesToBigInt(signature.slice(32));
if (s > n / 2n) s = n - s;                          // OpenAC requires low-S
const deviceSignature = base64url(concat(signature.slice(0, 32), bigIntTo32Bytes(s)));
```

Verification in the verifier route:

```ts
const policy = { claim: 'birth_ymd', op: '<=', value: cutoffYmd(18), format: 'uint' };
const compiled = compilePredicateExpression(policy, schemaClaims);
const r = await openac.verify(proof, vks, { nonce, predicates: compiled.predicates,
  logicExpression: compiled.logicExpression, claimNormalization: requiredNormalization(compiled) });
if (!r.valid || !r.issuerKey || !sameJwk(r.issuerKey.jwk, TRUSTED_ISSUER_JWK)) return { accepted: false };
return { accepted: true, over18: r.expressionResult };
```

`schemaClaims` is the claim list of the Age credential as the verifier knows it; for the PoC, hard-code it to match the issuer’s disclosure order. The trust check is not optional: without it, a self-signed credential verifies as valid.

### Step 6. Dry run

Run issue, precompute, challenge, present and verify end to end three times. Then run the negative tests from the demo script (reused nonce, wrong issuer, under-18 credential). Record timings for the workshop.

## Walkthrough: testing the integration on the agent controller

This walkthrough tests the whole flow on one controller with curl (or the same calls in Swagger at `/docs`). Each step ends with a checkpoint. If a checkpoint fails, stop and use the troubleshooting table before going on.

The `/openac` routes are the new ones from Step 5 of the implementation plan, so their request bodies below are the proposed contract. All other routes already exist in the controller.

### Setup

Start the controller with `docker compose up`. The admin API listens on port 4001 in the sample config.

```bash
export BASE=http://localhost:4001
export API_KEY=<controller api key>
```

### 1. Get a root token

```bash
curl -s -X POST $BASE/agent/token -H "Authorization: $API_KEY"
# save .token as ROOT
```

Checkpoint: the response contains a `token`.

### 2. Create three tenants

Run this three times with labels `ndi-issuer`, `ndi-holder` and `ndi-verifier`. Save each `token` as `ISSUER`, `HOLDER` and `VERIFIER`.

```bash
curl -s -X POST $BASE/multi-tenancy/create-tenant \
  -H "Authorization: Bearer $ROOT" -H "Content-Type: application/json" \
  -d '{"config":{"label":"ndi-issuer"}}'
```

Checkpoint: each response has an `id` and a `token`.

### 3. Issuer: create a P-256 DID

```bash
curl -s -X POST $BASE/dids/write -H "Authorization: Bearer $ISSUER" \
  -H "Content-Type: application/json" -d '{"method":"key","keyType":"p256"}'
```

Save the DID as `ISSUER_DID` and its verification method id (`did:key:...#...`) as `ISSUER_VM`.

Checkpoint: `GET $BASE/dids/$ISSUER_DID` shows a key with `crv: "P-256"`.

### 4. Issuer: create the OID4VC issuer

```bash
curl -s -X POST $BASE/openid4vc/issuer -H "Authorization: Bearer $ISSUER" \
  -H "Content-Type: application/json" -d '{
  "issuerId": "ndi-age",
  "credentialConfigurationsSupported": {
    "AgeCredential-sdjwt": {
      "format": "dc+sd-jwt", "vct": "AgeCredential",
      "cryptographic_binding_methods_supported": ["jwk"],
      "credential_signing_alg_values_supported": ["ES256"],
      "proof_types_supported": {"jwt": {"proof_signing_alg_values_supported": ["ES256"]}}
    }}}'
```

Save the returned public issuer id as `PUBLIC_ISSUER_ID`.

Checkpoint: `GET $BASE/openid4vc/issuer/ndi-age/metadata` lists `jwk` as the only binding method and `ES256` as the only algorithm.

### 5. Issuer: create the credential offer

```bash
curl -s -X POST $BASE/openid4vc/issuance-sessions/create-credential-offer \
  -H "Authorization: Bearer $ISSUER" -H "Content-Type: application/json" -d '{
  "publicIssuerId": "'$PUBLIC_ISSUER_ID'",
  "preAuthorizedCodeFlowConfig": {},
  "credentials": [{
    "credentialSupportedId": "AgeCredential-sdjwt", "format": "dc+sd-jwt",
    "signerOptions": {"method": "did", "did": "'$ISSUER_VM'"},
    "payload": {"vct": "AgeCredential", "birth_ymd": "20000514", "country_of_residence": "BT"},
    "disclosureFrame": {"_sd": ["birth_ymd", "country_of_residence"]}
  }]}'
```

Save `credentialOffer` as `OFFER`.

Checkpoint: `OFFER` starts with `openid-credential-offer://`.

### 6. Holder: accept the offer

```bash
curl -s -X POST $BASE/openid4vc/holder/resolve-credential-offer -H "Authorization: Bearer $HOLDER" \
  -H "Content-Type: application/json" -d '{"credentialOfferUri":"'$OFFER'"}'

curl -s -X POST $BASE/openid4vc/holder/request-credential -H "Authorization: Bearer $HOLDER" \
  -H "Content-Type: application/json" \
  -d '{"credentialOfferUri":"'$OFFER'","credentialsToRequest":["AgeCredential-sdjwt"]}'
```

Checkpoint: the second call returns the issued credential with no binding error.

### 7. Holder: inspect the stored credential

```bash
curl -s $BASE/openid4vc/holder/sd-jwt-vcs -H "Authorization: Bearer $HOLDER"
# save the record id as CRED_ID and the compact SD-JWT as SDJWT

curl -s -X POST $BASE/openid4vc/holder/decode-sdjwt -H "Authorization: Bearer $HOLDER" \
  -H "Content-Type: application/json" -d '{"jwt":"'$SDJWT'"}'
```

Checkpoint: all four must hold before going on.

| Check | Expected |
| --- | --- |
| Header `alg` | `ES256` |
| Payload `cnf` | `cnf.jwk` with `crv: "P-256"`, not `cnf.kid` |
| Disclosed claims | `birth_ymd: "20000514"` and `country_of_residence: "BT"` |
| No `status` claim | The PoC has no revocation |

### 8. Holder: Prepare

```bash
curl -s -X POST $BASE/openac/holder/precompute -H "Authorization: Bearer $HOLDER" \
  -H "Content-Type: application/json" -d '{"credentialId":"'$CRED_ID'","policy":"over18"}'
```

Checkpoint: the response reports success and a duration. Note the time for the workshop.

### 9. Verifier: issue a challenge

```bash
curl -s -X POST $BASE/openac/verifier/challenge -H "Authorization: Bearer $VERIFIER" \
  -H "Content-Type: application/json" -d '{"policy":"over18"}'
# save .nonce as NONCE
```

Checkpoint: `NONCE` is 43 base64url characters (32 bytes) and the response has an expiry about 2 minutes ahead.

### 10. Holder: Show (present)

```bash
curl -s -X POST $BASE/openac/holder/present -H "Authorization: Bearer $HOLDER" \
  -H "Content-Type: application/json" \
  -d '{"credentialId":"'$CRED_ID'","nonce":"'$NONCE'","policy":"over18"}' > proof.json
```

Checkpoint: `proof.json` contains proof data only. Search it for `20000514`, `BT` and the holder’s `x` coordinate; none should appear.

### 11. Verifier: verify

```bash
curl -s -X POST $BASE/openac/verifier/verify -H "Authorization: Bearer $VERIFIER" \
  -H "Content-Type: application/json" \
  -d '{"nonce":"'$NONCE'","proof":'"$(cat proof.json)"'}'
```

Checkpoint: `{"accepted": true, "over18": true}`.

### 12. Negative tests

| Test | How | Expected result |
| --- | --- | --- |
| Replay | Repeat step 11 with the same nonce and proof | Rejected: nonce already used |
| Expired challenge | Wait past the expiry, then run steps 10 and 11 | Rejected: nonce expired |
| Untrusted issuer | Repeat steps 3–11 with a second issuer DID not in the trust list | Proof is valid, but `accepted: false` |
| Under 18 | Issue with `birth_ymd: "20120101"`, then steps 6–11 | `accepted: true`, `over18: false` |
| Unlinkability | Run steps 9–10 twice; compare both proofs | No shared values between the two proofs |

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No supported binding method` at step 6 | Issuer config missing `jwk` or ES256 proof type | Recreate the issuer exactly as in step 4 |
| `cnf.kid` instead of `cnf.jwk` at step 7 | A DID method is listed in binding methods | Keep only `jwk` in `cryptographic_binding_methods_supported` |
| Precompute fails on size | Signing input over 1,280 bytes (the `1k` circuit), more than 2 claims, or an x5c header | Use a DID signer and only `birth_ymd` and `country_of_residence` |
| `CLAIM_FORMAT_MISMATCH` at step 10 | Precompute and present used different claim formats | Use `format: "uint"` for `birth_ymd` in both |
| Verify fails on the device signature | Askar signature not normalised to low-S, or DER-encoded | Apply the low-S code from Step 5; use raw \`r |
| `yarn install` fails in `patch-package` | `openac-sdk` is not exactly `5.0.0`, or the patched file name changed | Pin `5.0.0` with no caret and recreate the patch with `yarn patch-package openac-sdk` |
| Valid proof but `accepted: false` | Trusted issuer JWK does not match the issuer DID key | Set the verifier’s trusted JWK from step 3’s DID document |

## Workshop agenda and teaching script

The session runs 90 minutes: explain with the analogy first, then show the live demo, then break it on purpose so people see what the proof protects against.

| Time | Segment | What to say or do |
| --- | --- | --- |
| 0–10 min | The problem | Show a normal NDI presentation of a birth date. Ask: “What does the verifier now know that it didn’t need?” |
| 10–25 min | OpenAC in plain words | Bouncer and sealed-note analogy; Prepare, Show, Verify; the key terms table |
| 25–35 min | How it maps to our stack | Walk through the architecture diagram: three tenants, one new controller, one SDK patch |
| 35–60 min | Live demo | Run the demo steps below with Swagger or Postman |
| 60–75 min | Break it on purpose | Run the three negative tests below |
| 75–90 min | What it means for NDI | Use cases, cloud wallet vs mobile holder trade-off, limits, next steps; questions |

**Live demo steps**

1. Issuer creates the P-256 DID and the Age credential offer. Show the offer URI.
2. Holder accepts the offer. Decode the SD-JWT and point at `birth_ymd` and `cnf.jwk`: “This is what we would normally hand over.”
3. Holder runs Precompute. Mention the time it took: “this is the once-only, slow part.”
4. Verifier creates a challenge for “over 18”. Show the nonce and the policy, and point out there is no request for the birth date.
5. Holder presents. Show the proof JSON: a block of numbers, with no name, birth date or key in it.
6. Verifier verifies. The result is `accepted: true, over18: true`. Ask: “What did the verifier learn?” The answer is one bit.
7. Run Present twice on new nonces and show the two proofs side by side: they share nothing a verifier could match.

**Negative tests**

- **Replay:** submit the same proof again. The verifier rejects it because the nonce was already used.
- **Fake issuer:** issue an Age credential from a second P-256 DID that is not on the trust list. The proof is mathematically valid, but the trust check rejects it. Use this to explain why issuer trust is NDI’s job, not the SDK’s.
- **Under 18:** issue a credential with `birth_ymd: "20120101"`. Verification passes but `over18` is `false`; the holder cannot fake the answer.

**Lines worth repeating**

- “The verifier gets an answer, not the data.”
- “The issuer signs exactly as before; the privacy is added by the holder.”
- “The holder can be NDI’s cloud wallet or the citizen’s phone; the verifier sees the same proof either way. The difference is who else could see the data: with the phone, only the citizen holds the key.”

## Limitations and what production would need

The PoC shows the cryptography works with our stack; it does not yet deliver the privacy guarantees a citizen deployment needs.

| Limitation in the PoC | Why it matters | What production needs |
| --- | --- | --- |
| Holder is the cloud wallet | Verifiers cannot link a citizen, but NDI as wallet operator holds the claims and key and could see every presentation | Document the operator trust assumption and restrict and audit presentation logs; offer mobile proving with a hardware-backed P-256 key (in progress) for the strongest privacy |
| No revocation | A revoked credential would still prove | Privacy-preserving revocation, e.g. a Sparse Merkle Tree non-membership proof as in the zkID proof-of-personhood spec; the Token Status List index would make proofs linkable |
| REST endpoints, not a standard protocol | Other wallets and verifiers cannot interoperate | An OpenAC format in OID4VP or a DIDComm present-proof attachment |
| No audience binding | A proof made for one verifier could be relayed to another within the nonce lifetime | Nonce bound to verifier identity, e.g. a verifier-signed challenge |
| In-memory nonce and precompute caches | Lost on restart; single instance only | Persistent replay cache scoped by verifier, profile and nonce |
| Circuit limits (2 claims, 2 predicates, 1,280-byte signing input for `1k`, up to 2,048 / 4,096 / 8,192 for the larger circuits) | Cannot prove over a full national ID credential | Purpose-built compact credentials, or larger circuit parameters |
| Draft spec and reference SDK, patched in place | No test vectors yet; our `deviceSignature` patch is private to the controller and tied to the 5.0.0 build | Track spec status; keep `openac-sdk` pinned; propose `deviceSignature` upstream so no patch is needed; security review before national use |

The issuer also changes: NDI issuers sign with `did:ethr` (secp256k1) today, and OpenAC needs a P-256 issuer key.

## Checklist and fallback

Finish every item below before the session; if the controller integration is not working one hour before, switch to the fallback.

- [ ] `openac-sdk@5.0.0` is pinned, `patches/openac-sdk+5.0.0.patch` applies on `yarn install`, and the SDK loads in the controller (Node 18+, CommonJS build)
- [ ] The four `1k` proving and verifying keys are downloaded, hash-checked and loaded locally
- [ ] Issuer tenant has a P-256 `did:key` and an issuer config with `jwk`-only binding
- [ ] Issued Age credential decodes with `cnf.jwk` on P-256 and fits the circuit size limits
- [ ] Holder `keyId` is recorded and `kms.sign` returns 64-byte signatures
- [ ] Full flow passes 3 times; timings noted for Precompute, Present and Verify
- [ ] All three negative tests behave as expected
- [ ] Second, untrusted P-256 DID and an under-18 credential prepared for the negative tests
- [ ] Postman collection or Swagger tabs ordered in demo sequence
- [ ] Precompute already run once, in case it is slow on the demo machine

**Fallback.** Run Prepare, Show and Verify standalone with the SDK’s `generateDummyCredential` from `openac-sdk/testing`, in a short Node script. It skips issuance and the controller, but still demonstrates the core idea: a verifier gets a true/false answer and nothing else. Present the controller integration as the architecture diagram and the next step.
