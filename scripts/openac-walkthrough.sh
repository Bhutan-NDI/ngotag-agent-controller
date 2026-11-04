#!/usr/bin/env bash
#
# OpenAC PoC walkthrough: issuer, holder and verifier as three tenants on one agent controller.
# Spec: docs/openac-poc-plan.md ("Walkthrough: testing the integration on the agent controller").
#
# Every checkpoint is asserted; the script stops at the first failure and prints the response that failed.
#
# Usage:
#   BASE=http://localhost:4001 API_KEY=<controller api key> scripts/openac-walkthrough.sh
#
# Environment:
#   BASE       controller admin API (default http://localhost:4001)
#   API_KEY    controller API key (required)
#   RUN        suffix for tenant labels so reruns do not collide (default: unix time)
#   UNTIL      stop after this walkthrough step, 1..12 (default: run every implemented step)
#   BIRTH_YMD  birth date in the credential, a YYYYMMDD string (default 20000514)
#
# Implemented so far: steps 1-5. Steps 6-12 are added with their plan steps.

set -euo pipefail

BASE="${BASE:-http://localhost:4001}"
: "${API_KEY:?Set API_KEY to the controller API key}"
RUN="${RUN:-$(date +%s)}"
UNTIL="${UNTIL:-99}"
BIRTH_YMD="${BIRTH_YMD:-20000514}"

# The plan's Age credential. country_of_residence is deliberately long: Credo uses 16-character salts and the
# 1k Prepare circuit rejects any disclosure shorter than 42 bytes of JSON (see the Step 0 findings).
CREDENTIAL_CONFIG_ID="AgeCredential-sdjwt"
VCT="AgeCredential"
ISSUER_ID="ndi-age"

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 2; }
done

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

step() { printf '\n== %s\n' "$*"; }
pass() { printf '   ok: %s\n' "$*"; }
die() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}

# api METHOD PATH AUTH_HEADER_VALUE [JSON_BODY] -> response body on stdout; fails on any non-2xx.
api() {
  local method="$1" path="$2" auth="$3" body="${4:-}" code
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$BASE$path" -H "Authorization: $auth")
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  code="$(curl "${args[@]}")" || die "$method $path: could not reach $BASE"
  if [[ "$code" != 2* ]]; then
    die "$method $path returned HTTP $code: $(cat "$BODY_FILE")"
  fi
  cat "$BODY_FILE"
}

# field JSON JQ_FILTER -> the value, or fails (printing the JSON) when it is missing or null.
field() {
  local json="$1" filter="$2" value
  value="$(jq -r "$filter // empty" <<<"$json")"
  [[ -n "$value" ]] || die "expected $filter in response: $json"
  printf '%s' "$value"
}

assert_eq() { # DESCRIPTION ACTUAL EXPECTED
  [[ "$2" == "$3" ]] || die "$1: expected '$3', got '$2'"
  pass "$1"
}

assert_match() { # DESCRIPTION VALUE REGEX
  [[ "$2" =~ $3 ]] || die "$1: '$2' does not match $3"
  pass "$1"
}

stop_if_reached() {
  if (( UNTIL <= $1 )); then
    printf '\nStopped after step %s (UNTIL=%s).\n' "$1" "$UNTIL"
    exit 0
  fi
}

# --- 1. Root token ---------------------------------------------------------------------------------------------
step "1. Get a root token"
# /agent/token authenticates with the raw API key (no "Bearer"); every other route uses "Bearer <token>".
resp="$(api POST /agent/token "$API_KEY")"
ROOT="$(field "$resp" '.token')"
pass "root token received"
stop_if_reached 1

# --- 2. Three tenants ------------------------------------------------------------------------------------------
step "2. Create three tenants"
create_tenant() { # ROLE -> prints "id token"
  local label="ndi-$1-$RUN" out id token
  out="$(api POST /multi-tenancy/create-tenant "Bearer $ROOT" "$(jq -n --arg l "$label" '{config: {label: $l}}')")"
  id="$(field "$out" '.id')"
  token="$(field "$out" '.token')"
  printf '%s %s' "$id" "$token"
}
read -r ISSUER_TENANT_ID ISSUER <<<"$(create_tenant issuer)"
read -r HOLDER_TENANT_ID HOLDER <<<"$(create_tenant holder)"
read -r VERIFIER_TENANT_ID VERIFIER <<<"$(create_tenant verifier)"
pass "issuer tenant $ISSUER_TENANT_ID, holder tenant $HOLDER_TENANT_ID, verifier tenant $VERIFIER_TENANT_ID"
stop_if_reached 2

# --- 3. Issuer: P-256 did:key ----------------------------------------------------------------------------------
step "3. Issuer: create a P-256 DID"
resp="$(api POST /dids/write "Bearer $ISSUER" '{"method":"key","keyType":"p256"}')"
ISSUER_DID="$(field "$resp" '.did')"
assert_match "issuer DID is a did:key" "$ISSUER_DID" '^did:key:z'
# P-256 did:keys carry the multicodec prefix 0x1200, which base58btc-encodes as "zDn".
assert_match "issuer DID is a P-256 key (zDn...)" "$ISSUER_DID" '^did:key:zDn'
# The issuer signer takes the plain DID: the controller resolves it and uses the first verification method
# (src/utils/oid4vc-agent.ts), so the verification method id (did:key:...#...) is not needed.
resolved="$(api GET "/dids/$ISSUER_DID" "Bearer $ISSUER")"
issuer_crv="$(jq -r '.didDocument.verificationMethod[0].publicKeyJwk.crv // empty' <<<"$resolved")"
[[ -n "$issuer_crv" ]] || die "no publicKeyJwk.crv on the issuer DID's first verification method: $resolved"
assert_eq "issuer DID key curve" "$issuer_crv" "P-256"
stop_if_reached 3

# --- 4. Issuer: OID4VC issuer ----------------------------------------------------------------------------------
step "4. Issuer: create the OID4VC issuer (jwk-only binding, ES256)"
issuer_body="$(jq -n --arg id "$ISSUER_ID" --arg cfg "$CREDENTIAL_CONFIG_ID" --arg vct "$VCT" '{
  issuerId: $id,
  credentialConfigurationsSupported: {
    ($cfg): {
      format: "dc+sd-jwt",
      vct: $vct,
      cryptographic_binding_methods_supported: ["jwk"],
      credential_signing_alg_values_supported: ["ES256"],
      proof_types_supported: { jwt: { proof_signing_alg_values_supported: ["ES256"] } }
    }
  }
}')"
resp="$(api POST /openid4vc/issuer "Bearer $ISSUER" "$issuer_body")"
PUBLIC_ISSUER_ID="$(field "$resp" '.issuerId')"
metadata="$(api GET "/openid4vc/issuer/$PUBLIC_ISSUER_ID/metadata" "Bearer $ISSUER")"
config="$(jq -c --arg cfg "$CREDENTIAL_CONFIG_ID" '.credentialIssuer.credential_configurations_supported[$cfg] // empty' <<<"$metadata")"
[[ -n "$config" ]] || die "metadata has no credential configuration $CREDENTIAL_CONFIG_ID: $metadata"
assert_eq "binding methods are exactly [jwk]" "$(jq -c '.cryptographic_binding_methods_supported' <<<"$config")" '["jwk"]'
assert_eq "signing algorithms are exactly [ES256]" "$(jq -c '.credential_signing_alg_values_supported' <<<"$config")" '["ES256"]'
stop_if_reached 4

# --- 5. Issuer: credential offer -------------------------------------------------------------------------------
step "5. Issuer: create the credential offer"
assert_match "BIRTH_YMD is an 8-digit string" "$BIRTH_YMD" '^[0-9]{8}$'
offer_body="$(jq -n --arg issuer "$PUBLIC_ISSUER_ID" --arg cfg "$CREDENTIAL_CONFIG_ID" --arg did "$ISSUER_DID" \
  --arg vct "$VCT" --arg birth "$BIRTH_YMD" '{
  publicIssuerId: $issuer,
  preAuthorizedCodeFlowConfig: {},
  credentials: [{
    credentialSupportedId: $cfg,
    format: "dc+sd-jwt",
    signerOptions: { method: "did", did: $did },
    payload: { vct: $vct, birth_ymd: $birth, country_of_residence: "BT" },
    disclosureFrame: { _sd: ["birth_ymd", "country_of_residence"] }
  }]
}')"
resp="$(api POST /openid4vc/issuance-sessions/create-credential-offer "Bearer $ISSUER" "$offer_body")"
OFFER="$(field "$resp" '.credentialOffer')"
assert_match "offer is an openid-credential-offer URI" "$OFFER" '^openid-credential-offer://'
stop_if_reached 5

printf '\nSteps 6-12 are not implemented yet; steps 1-5 passed.\n'
