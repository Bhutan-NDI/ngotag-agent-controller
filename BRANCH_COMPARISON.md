# feat/ethereum-integration-v2.2.0 vs develop

Merge-base: `71ee6af` — 10 commits ahead of `develop`.

## Commits unique to this branch
```
67de412 ayanwork credo version
7ffabf5 fix(jsonld): route did:ethr context loads through wrapped document loader (#51)
b47c9f5 Merge pull request #49 from Bhutan-NDI/feat/pick-eth-vars
072349e Merge pull request #34 from Bhutan-NDI/feat/migrate-ethr-schema
fcf90dc Merge pull request #31 from fix/ethr-did-resolution
c0e8a7e Merge pull request #30 from Bhutan-NDI/hot-fix/mainnet-did-syntax
48c0b6b Merge pull request #22 from Bhutan-NDI/ethr-integration
01d4a43 Merge pull request #21 from Bhutan-NDI/ethr-integration
cf5f187 Merge pull request #20 from Bhutan-NDI/ethr-integration
2f69e82 Merge pull request #19 from Bhutan-NDI/ethr-integration
```

## Files changed (16 files, +711/-20)

### New dependency
- `package.json`: adds `@bhutan-ndi/ethr-credo-module@1.0.3` (the `did:ethr` Credo module — registrar/resolver/module class).
- `yarn.lock`: pulls in the new module's transitive deps (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@adraffy/ens-normalize`, `@scure/base`, ethers-related packages, etc.).

### New patches
- `patches/@ayanworks+credo-polygon-w3c-module+2.0.2.patch` (new) — patches the Polygon module (needed alongside the ethr module changes).
- `patches/@credo-ts+core+0.6.2+003+support public key hex for did-ethr verification method.patch` (new) — patches `EcdsaSecp256k1VerificationKey2019.mjs` so `getPublicJwkFromEcdsaSecp256k1VerificationKey2019` accepts `publicKeyHex` in addition to `publicKeyBase58` (did:ethr verification methods use hex-encoded keys, base `@credo-ts/core` only supported base58).

### `src/enums/enum.ts`
- Adds `Ethereum = 'ethr'` to `DidMethod` enum.

### `src/controllers/types.ts`
- `DidCreate` interface: adds optional `address?: string`.
- `supportedKeyTypesDID`: adds `[DidMethod.Ethereum]: [{ kty: 'EC', crv: 'secp256k1' }]`.

### `src/controllers/did/DidController.ts`
- Imports `EthereumDidCreateOptions` from `@bhutan-ndi/ethr-credo-module/build/dids` (also switches the Polygon type import off the old `.mjs` deep path to the package's `build/dids` barrel).
- Adds `DidMethod.Ethereum` case in the create-DID switch, dispatching to a new `handleEthereum()`.
- New `handleEthereum(agent, createDidOptions)`:
  - Validates `network` is `mainnet` or `sepolia` (from `network` like `ethr:sepolia`), throws otherwise.
  - Validates `privatekey` is present.
  - Calls `agent.dids.create<EthereumDidCreateOptions>()` with method `ethr`, `options: { network, endpoint }` (mainnet maps to `''`), `secret: { privateKey: TypedArrayEncoder.fromHex(privatekey) }`.
  - Returns `{ did, didDoc }`.

### `src/controllers/ethereum/EthereumController.ts` (new file, 203 lines)
New `Ethereum` controller mounted at `/ethereum` (Tags: `Ethereum`, apiKey-secured):
- `POST /ethereum/create-keys` — generates a secp256k1 key pair + address via `generateSecp256k1KeyPair()` (from the Polygon module).
- `POST /ethereum/create-schema` — creates a W3C schema on-chain via `agent.modules.ethereum.createSchema()`, builds the schema URL from `config.json`'s `schemaFileServerURL`.
- `POST /ethereum/migrate-schema` — migrates/re-registers an existing schema via `agent.modules.ethereum.createExistingSchema()`.
- `GET /ethereum/:did/:schemaId` — fetches schema details via `agent.modules.ethereum.getSchemaById()`, maps `UnauthorizedClientRequest` errors to 401.
- An `estimate-transaction` endpoint is present but fully commented out (dead code, not wired up).

### `src/cliAgent.ts`
- Imports `EthereumDidRegistrar`, `EthereumDidResolver`, `EthereumModule` from `@bhutan-ndi/ethr-credo-module`.
- `AriesRestConfig` gains: `ethereumNetworkName`, `ethereumChainId`, `ethereumRegistry`, `ethereumSchemaManagerContractAddress`, `ethereumRpcUrl`.
- New `EthereumModuleEnvironmentConfig` interface, threaded as an extra param through `getModules()` / `getWithTenantModules()`.
- `getModules()`: registers `EthereumDidRegistrar`/`EthereumDidResolver` in the dids module, and adds a new `ethereum: new EthereumModule({...})` module — config sourced from `ethereumModuleConfig` first, falling back to `process.env.ETHEREUM_NETWORK_NAME` / `ETHEREUM_CHAIN_ID` / `ETHEREUM_RPC_URL` / `ETHEREUM_DID_REGISTRY_CONTRACT_ADDRESS` / `ETHEREUM_SCHEMA_MANAGER_CONTRACT_ADDRESS`.
- `runRestAgent()` destructures the new config fields and builds/passes `ethereumModuleConfig` into `getModules`/`getWithTenantModules`.

### `src/cli.ts`
- CLI flag parsing (`Parsed` interface) gains `ethereumNetworkName`, `ethereumChainId`, `ethereumRegistry`, `ethereumSchemaManagerContractAddress`, `ethereumRpcUrl`, plus short aliases `chainId`, `chainName`, `registry`.
- Passes these through to `runRestAgent`, preferring the explicit `ethereum*` flag over the short alias (`parsed.ethereumChainId || parsed.chainId`, etc.).
- Cast to `AriesRestConfig` changed to `as unknown as AriesRestConfig` (looser cast, likely because the config shape grew).

### `.env.sample`
New env vars documented:
- `ETHEREUM_NETWORK_NAME`, `ETHEREUM_CHAIN_ID`, `ETHEREUM_DID_REGISTRY_CONTRACT_ADDRESS`, `ETHEREUM_SCHEMA_MANAGER_CONTRACT_ADDRESS`, `ETHEREUM_RPC_URL`
- Also (unrelated to Ethereum, came in via other merged PRs on this branch): `REDIS_URL`, `REDIS_CACHE_TTL_SECONDS`, `NATS_URL`, `ADMIN_TOKEN`, plus a comment block on `INMEMORY_LRU_CACHE_LIMIT`.

### `src/utils/customDocumentLoader.ts`
- Adds an embedded static context map (`STATIC_CONTEXTS`) for `secp256k1recovery-2020/v2` (both the canonical `w3id.org` URL and the `identity.foundation` redirect target), backed by a new file `src/utils/staticContexts/secp256k1recovery2020v2.ts` (112 lines, the raw JSON-LD context) — avoids a network fetch when verifying did:ethr-issued credentials/proofs.
- Refactors the loader into a named `wrappedLoader` function (was an anonymous return) so it can recurse into itself.
- Adds handling for `did:` URLs: resolves via `DidsApi`, then `jsonld.frame()`s the DID document (using `wrappedLoader` as the nested document loader) so any `@context` referenced *inside* a did:ethr DID document (e.g. the secp256k1recovery-2020 suite) is resolved through the same static-context/DID-aware pipeline instead of falling through to a live fetch.

### `tsconfig.json` / `tsconfig.build.json`
- `tsconfig.json`: adds `"ignoreDeprecations": "5.0"`.
- `tsconfig.build.json`: adds `"rootDir": "./src"`.

## Net effect
This branch adds full `did:ethr` support end-to-end:
1. DID create/resolve for `did:ethr` (mainnet/sepolia) via a new Credo module + patched core.
2. A dedicated `/ethereum` REST surface for key generation and on-chain W3C schema create/migrate/fetch.
3. Config plumbing (env vars, CLI flags, module wiring) for the Ethereum network/registry/RPC/schema-manager.
4. Document-loader changes so did:ethr credentials/proofs verify without live network calls for the recovery-2020 JSON-LD context.

## ⚠️ Not part of the branch diff — uncommitted working-tree state
Your working tree currently has **uncommitted** changes on top of this branch that look unrelated/in-progress and partially conflict with the above (not included in the comparison above since they aren't committed):
- Deletes `src/utils/customDocumentLoader.ts` entirely, and modifies `src/cli.ts`, `src/cliAgent.ts`, `src/controllers/did/DidController.ts`, `src/server.ts`, `.env.sample`, `package.json`, `yarn.lock`.
- Deletes several of the patches this branch added (Polygon 2.0.2 patch, core 0.6.2 patches, openid4vc patch, jsonld-signatures patch) and adds a different, larger set of patches pinned to `@credo-ts/core@0.5.3` / `@credo-ts/anoncreds@0.5.3` / `@credo-ts/tenants@0.5.3` / `@sphereon/pex@3.3.3`.
- New untracked files: `src/instrumentation/`, `src/utils/CachedDocumentLoader.ts`, `src/utils/RedisCache.ts`, `src/utils/StructuredLogger.ts`.
- Several stray untracked files/dirs with garbled names (`Anoncreds`, `Did.patch`, `Extensible`, `abandoned`, `and`, `avoid`, `confict`, `in`, `issue.patch`, `model`, `rpc`, `to`, `url.patch`, `validationPresentation`) — these look like a shell command with an unquoted patch filename (containing spaces/colons) got split into separate files. Worth cleaning up.

Let me know if you want a second pass documenting *that* working-tree state (it looks like it might be an in-progress downgrade from `@credo-ts@0.6.2` back to `0.5.3`, separate from the Ethereum work), or if it should just be discarded.
