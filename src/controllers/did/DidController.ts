import type { DidResolutionResultProps } from '../types'
import type { PolygonDidCreateOptions } from '@ayanworks/credo-polygon-w3c-module/build/dids/PolygonDidRegistrar.mjs'
import type { EthereumDidCreateOptions } from '@bhutan-ndi/ethr-credo-module/build/dids'
import type { DidDocument, KeyDidCreateOptions, PeerDidNumAlgo2CreateOptions } from '@credo-ts/core'

import { transformPrivateKeyToPrivateJwk, transformSeedToPrivateJwk } from '@credo-ts/askar'
import {
  TypedArrayEncoder,
  DidDocumentBuilder,
  getEd25519VerificationKey2018,
  createPeerDidDocumentFromServices,
  PeerDidNumAlgo,
  Kms,
  Hasher,
  LogLevel,
  Agent,
  DidKey,
  DidRepository,
  DidDocumentRole,
  RecordNotFoundError,
} from '@credo-ts/core'
import { Key, KeyAlgorithm, askar } from '@openwallet-foundation/askar-nodejs'
import axios from 'axios'
import { Request as Req } from 'express'
import { Body, Controller, Example, Get, Path, Post, Query, Route, Tags, Security, Request } from 'tsoa'
import { injectable } from 'tsyringe'
import { container } from 'tsyringe'

import { RestMultiTenantAgentModules } from '../../cliAgent'
import { DidMethod, KeyAlgorithmCurve, Network, NetworkTypes, Role, SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { BadRequestError, InternalServerError } from '../../errors'
import { AgentType } from '../../types'
import { keyAlgorithmToCurve, p521, verkey } from '../../utils/constant'
import { getTypeFromCurve } from '../../utils/helpers'
import { CreateDidResponse, Did, DidRecordExample } from '../examples'
import { DidCreate, supportedKeyTypesDID } from '../types'

@Tags('Dids')
@Route('/dids')
@Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
@injectable()
export class DidController extends Controller {
  /**
   * Resolves did and returns did resolution result
   * @param did Decentralized Identifier
   * @returns DidResolutionResult
   */
  private agent = container.resolve(Agent<RestMultiTenantAgentModules>)

  @Example<DidResolutionResultProps>(DidRecordExample)
  @Get('/:did')
  public async getDidRecordByDid(@Request() request: Req, @Path('did') did: Did) {
    try {
      const resolveResult = await request.agent.dids.resolve(did)
      const importDid = await request.agent.dids.import({
        did,
        overwrite: true,
      })
      if (!resolveResult.didDocument) {
        throw new InternalServerError(`Error resolving DID docs for did: ${importDid}`)
      }

      return { ...resolveResult, didDocument: resolveResult.didDocument.toJSON() }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Did nym registration
   * @body DidCreateOptions
   * @returns DidResolutionResult
   */
  // @Example<DidResolutionResultProps>(DidRecordExample)
  @Example(CreateDidResponse)
  @Post('/write')
  public async writeDid(@Request() request: Req, @Body() createDidOptions: DidCreate) {
    let didRes

    this.agent.config.logger.info(`askar version ${askar.version()}`)
    try {
      if (!createDidOptions.method) {
        throw new BadRequestError('Method is required')
      }

      let result
      switch (createDidOptions.method) {
        case DidMethod.Indy:
          result = await this.handleIndy(request.agent, createDidOptions)
          break

        case DidMethod.Key:
          result = await this.handleKey(request.agent, createDidOptions)
          break

        case DidMethod.Web:
          result = await this.handleWeb(request.agent, createDidOptions)
          break

        case DidMethod.Polygon:
          result = await this.handlePolygon(request.agent, createDidOptions)
          break

        case DidMethod.Peer:
          result = await this.handleDidPeer(request.agent, createDidOptions)
          break

        case DidMethod.Ethereum:
          result = await this.handleEthereum(request.agent, createDidOptions)
          break

        default:
          throw new BadRequestError(`Invalid method: ${createDidOptions.method}`)
      }

      didRes = { ...result }

      // Tracked as a tag on the DID's own DidRecord, not a separate pointer record. Credo 0.6.2's
      // BaseRecord.setTag accepts arbitrary tag names (`keyof CustomTags | (string & {})`), the
      // value round-trips through AskarStorageService's transformFromRecordTagValues on both save
      // and query (booleans <-> "1"/"0"), so `setTag('isDefault', true)` followed later by
      // `findByQuery({ isDefault: true })` genuinely matches — verified directly against this
      // repo's installed @credo-ts/core/@credo-ts/askar packages. An earlier version of this code
      // moved isDefault tracking into a GenericRecord pointer on the (incorrect) belief that
      // DidRecord tags could no longer carry it; see the #75 review. Reverted back to tagging the
      // DidRecord directly: it needs no backfill (every DID ever created already carries this tag
      // if it was ever marked default) and keeps the read path (AgentController's self-attested
      // lookup, below) a plain tag query instead of a second record type to keep in sync.
      //
      // Two real bugs existed in the legacy (pre-migration) version of this same approach, both
      // fixed here: (1) it never cleared the previous default before tagging a new one, so
      // `findSingleByQuery` could find N previously-tagged DIDs and throw RecordDuplicateError —
      // fixed by clearing every other isDefault-tagged record for this tenant first; (2) it always
      // re-fetched the record via `getCreatedDids({ did, method: DidMethod.Key })`, so isDefault
      // silently no-opped (`undefined.setTag(...)` throwing, caught below) for any non-did:key
      // method — fixed by looking the record up by `did` alone, with no method restriction.
      //
      // Each individual write below goes through updateByIdWithLock, not a plain update: Askar's
      // implementation (AskarStorageService#updateByIdWithLock) wraps the read-modify-write in one
      // transaction with `forUpdate: true`, so a concurrent write racing the exact same record
      // can't silently clobber this one's tag. This closes the lost-update case per record — it does
      // not add a single mutex around the whole "list current defaults, then clear+set" sequence
      // (Credo's Repository API has no cross-record transaction), so two isDefault: true requests
      // for two *different* DIDs racing at the read step above can still both proceed to tag a
      // different record true. See the #75 review; a full fix needs a dedicated lock record, which
      // was deliberately not reintroduced here to avoid recreating the split-brain risk that came
      // with the GenericRecord pointer this same fix already reverted away from.
      //
      // Best-effort, in its own try/catch: the DID is the expensive, non-idempotent side effect
      // (for did:indy/did:bcovrin/did:indicio, already a ledger NYM by this point) — the isDefault
      // tag is not. A storage/Askar failure recording it must never turn an already-successful
      // creation into a 500, since the client's only recourse on a 500 is to retry the whole
      // request, anchoring a second, orphaned DID for a real ledger method. Logged as a warning,
      // and — per the #75 review — also surfaced on the response itself as `isDefaultSet: false`
      // when `isDefault` was requested but the bookkeeping below didn't actually happen: a client
      // that explicitly asked for this DID to become the default has no other way to learn its
      // request was silently not honored (a subsequent self-attested-issuance call would otherwise
      // just 404 or sign under a stale default, with no link back to this response). Absent
      // entirely (not `true`) when isDefault was never requested, so existing callers that don't
      // use isDefault see no shape change.
      let isDefaultSet: boolean | undefined
      try {
        // Cast, not a widened type: `result`'s inferred type is a union across all handler
        // branches and TS won't narrow it here without a per-branch type guard. Note that
        // handleIndicio's non-endorser branch returns the raw registrar result, hence the
        // didState fallback — every other branch (handleIndy's other paths, handleKey/handleWeb/
        // handlePolygon/handleDidPeer/handleEthereum, and handleBcovrin's equivalent non-endorser
        // branch) already normalizes to a top-level `did`.
        const createdDid =
          (didRes as { did?: string })?.did ?? (didRes as { didState?: { did?: string } })?.didState?.did
        if (createDidOptions.isDefault) {
          if (!createdDid) {
            throw new InternalServerError('isDefault was requested but the created did could not be determined')
          }
          const didRepository = request.agent.dependencyManager.resolve(DidRepository)
          const newDefaultRecord = await didRepository.findCreatedDid(request.agent.context, createdDid)
          if (!newDefaultRecord) {
            throw new InternalServerError(`isDefault was requested but no DidRecord could be found for ${createdDid}`)
          }
          // Tag the new default FIRST, then clear the previous ones -- not the other order. Both
          // writes are separate updateByIdWithLock calls (Credo's Repository API has no
          // cross-record transaction to lean on instead), so either order can still fail partway
          // through a real Askar/storage error or a lock timeout. Tagging first makes the worst
          // case strictly better: a failure after this write but before the clearing loop below
          // leaves the tenant with *two* tagged defaults, which the read path already tolerates
          // by design (findByQuery, not findSingleByQuery -- see AgentController's own comment on
          // the same query). The previous order's worst case was clearing every previous default
          // and then failing on this exact write, leaving the tenant with *zero* defaults and a
          // self-attested-issuance endpoint that 404s where it worked a moment before. See the
          // #73 review.
          await didRepository.updateByIdWithLock(request.agent.context, newDefaultRecord.id, async (record) => {
            record.setTag('isDefault', true)
            return record
          })
          const previousDefaults = await didRepository.findByQuery(request.agent.context, { isDefault: true })
          for (const previousDefault of previousDefaults) {
            if (previousDefault.id !== newDefaultRecord.id) {
              await didRepository.updateByIdWithLock(request.agent.context, previousDefault.id, async (record) => {
                record.setTag('isDefault', false)
                return record
              })
            }
          }
          isDefaultSet = true
        }
      } catch (bookkeepingError) {
        this.agent.config.logger.warn(
          `[DidController] isDefault bookkeeping failed for a newly created DID — the DID itself was created successfully and is still returned below: ${bookkeepingError}`,
        )
        if (createDidOptions.isDefault) {
          isDefaultSet = false
        }
      }

      return isDefaultSet === undefined ? didRes : { ...didRes, isDefaultSet }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  private async handleDidPeer(agent: AgentType, createDidOptions: DidCreate) {
    let didResponse
    let did

    if (!createDidOptions.keyType) {
      throw Error('keyType is required')
    }

    const didRouting = await agent.modules.didcomm.mediationRecipient.getRouting({})
    const { didDocument, keys } = createPeerDidDocumentFromServices(
      [
        {
          id: 'didcomm',
          recipientKeys: [didRouting.recipientKey],
          routingKeys: didRouting.routingKeys,
          serviceEndpoint: didRouting.endpoints[0],
        },
      ],
      true,
    )

    const didPeerResponse = await agent.dids.create<PeerDidNumAlgo2CreateOptions>({
      didDocument,
      method: DidMethod.Peer,
      options: {
        numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
        keys,
      },
    })

    did = didPeerResponse.didState.did
    didResponse = {
      did,
    }
    return didResponse
  }

  private async handleIndy(agent: AgentType, createDidOptions: DidCreate) {
    let result
    if (!createDidOptions.keyType) {
      throw new BadRequestError('keyType is required')
    }

    if (!createDidOptions.network) {
      throw new BadRequestError('For indy method network is required')
    }

    if (createDidOptions.keyType !== KeyAlgorithm.Ed25519) {
      throw new BadRequestError('Only ed25519 key type supported')
    }

    if (!Object.values(Network).includes(createDidOptions.network as Network)) {
      throw new BadRequestError(`Invalid network for 'indy' method: ${createDidOptions.network}`)
    }

    switch (createDidOptions?.network?.toLowerCase()) {
      case Network.Bcovrin_Testnet:
        result = await this.handleBcovrin(
          agent,
          createDidOptions,
          `did:${createDidOptions.method}:${createDidOptions.network}`,
        )
        break

      case Network.Indicio_Demonet:
      case Network.Indicio_Testnet:
        result = await this.handleIndicio(
          agent,
          createDidOptions,
          `did:${createDidOptions.method}:${createDidOptions.network}`,
        )
        break

      default:
        throw new BadRequestError(`Network does not exists`)
    }
    return result
  }

  private async handleBcovrin(agent: AgentType, createDidOptions: DidCreate, didMethod: string) {
    let didDocument
    if (!createDidOptions.seed) {
      throw new BadRequestError('Seed is required')
    }
    if (createDidOptions?.role?.toLowerCase() === Role.Endorser) {
      if (createDidOptions.did) {
        // Hint: Bcovrin uses seed as private key when creating key. But seed is written as a NYM transaction
        // Triage: Make sure what to use, seed or privateKey when accepting from API itself
        await this.importDid(agent, didMethod, createDidOptions.did, '', createDidOptions.seed)
        const getDid = await agent.dids.getCreatedDids({
          method: createDidOptions.method,
          did: `did:${createDidOptions.method}:${createDidOptions.network}:${createDidOptions.did}`,
        })
        if (getDid.length > 0) {
          didDocument = getDid[0].didDocument
        }

        return {
          did: `${didMethod}:${createDidOptions.did}`,
          didDocument: didDocument,
        }
      } else {
        if (!process.env.BCOVRIN_REGISTER_URL) {
          throw new InternalServerError('BCOVRIN_REGISTER_URL is not set in environment variables')
        }
        const BCOVRIN_REGISTER_URL = process.env.BCOVRIN_REGISTER_URL as string
        const res = await axios.post(BCOVRIN_REGISTER_URL, {
          role: 'ENDORSER',
          alias: 'Alias',
          seed: createDidOptions.seed,
        })
        const { did } = res?.data || {}
        await this.importDid(agent, didMethod, did, '', createDidOptions.seed)
        const didRecord = await agent.dids.getCreatedDids({
          method: DidMethod.Indy,
          did: `did:${DidMethod.Indy}:${Network.Bcovrin_Testnet}:${res.data.did}`,
        })

        if (didRecord.length > 0) {
          didDocument = didRecord[0].didDocument
        }

        return {
          did: `${didMethod}:${res.data.did}`,
          didDocument: didDocument,
        }
      }
    } else {
      if (!createDidOptions.endorserDid) {
        throw new BadRequestError('Please provide the endorser DID or role')
      }
      const didCreateTxResult = await this.createEndorserDid(agent, createDidOptions.endorserDid)
      return { did: didCreateTxResult.didState.did, didDocument: didCreateTxResult.didState.didDocument }
    }
  }

  private async handleIndicio(agent: AgentType, createDidOptions: DidCreate, didMethod: string) {
    let didDocument
    if (!createDidOptions.seed) {
      throw new BadRequestError('Seed is required')
    }
    if (createDidOptions?.role?.toLowerCase() === Role.Endorser) {
      if (createDidOptions.did) {
        await this.importDid(agent, didMethod, createDidOptions.did, createDidOptions.seed)
        const didRecord = await agent.dids.getCreatedDids({
          method: createDidOptions.method,
          did: `did:${createDidOptions.method}:${createDidOptions.network}:${createDidOptions.did}`,
        })

        if (didRecord.length > 0) {
          didDocument = didRecord[0].didDocument
        }

        return {
          did: `${didMethod}:${createDidOptions.did}`,
          didDocument: didDocument,
        }
      } else {
        const { keyId, ...key } = await this.createIndicioKey(agent, createDidOptions)
        const INDICIO_NYM_URL = process.env.INDICIO_NYM_URL as string
        const res = await axios.post(INDICIO_NYM_URL, key)
        if (res.data.statusCode === 200) {
          await this.importDid(agent, didMethod, key.did, createDidOptions.seed, undefined, keyId)
          const didRecord = await agent.dids.getCreatedDids({
            method: DidMethod.Indy,
            did: `${didMethod}:${key.did}`,
          })

          if (didRecord.length > 0) {
            didDocument = didRecord[0].didDocument
          }

          return {
            did: `${didMethod}:${key.did}`,
            didDocument: didDocument,
          }
        } else {
          throw new InternalServerError(
            `Failed to register DID with Indicio: ${res.data.message || res.data.body || 'Unknown error'}`,
          )
        }
      }
    } else {
      if (!createDidOptions.endorserDid) {
        throw new BadRequestError('Please provide the endorser DID or role')
      }
      const didCreateTxResult = await this.createEndorserDid(agent, createDidOptions.endorserDid)
      return didCreateTxResult
    }
  }

  private async createEndorserDid(agent: AgentType, endorserDid: string) {
    return agent.dids.create({
      method: 'indy',
      options: {
        endorserMode: 'external',
        endorserDid: endorserDid || '',
      },
    })
  }

  private async createIndicioKey(agent: AgentType, createDidOptions: DidCreate) {
    if (!createDidOptions.seed) {
      throw new BadRequestError('Seed is required')
    }
    // TODO: Remove comments afterwards
    // const key = await agent.kms.createKey({
    //     privateKey: TypedArrayEncoder.fromString(createDidOptions.seed),
    //     keyType: KeyAlgorithm.Ed25519,
    // })

    // const buffer = TypedArrayEncoder.fromBase58(key.publicKeyBase58)
    // const did = TypedArrayEncoder.toBase58(buffer.slice(0, 16))

    const privateJwk = transformSeedToPrivateJwk({
      seed: TypedArrayEncoder.fromString(createDidOptions.seed),
      type: {
        crv: 'Ed25519',
        kty: 'OKP',
      },
    }).privateJwk

    const key = await agent.kms.importKey({
      privateJwk,
    })

    const verificationKey = Kms.PublicJwk.fromPublicJwk(key.publicJwk) as Kms.PublicJwk<Kms.Ed25519PublicJwk>

    // Create a new key and calculate did according to the rules for indy did method
    const publicKeyBytes = verificationKey.publicKey.publicKey

    const did = TypedArrayEncoder.toBase58(publicKeyBytes.slice(0, 16))

    let body
    if (createDidOptions.network === Network.Indicio_Testnet) {
      body = {
        network: 'testnet',
        did,
        verkey: TypedArrayEncoder.toBase58(publicKeyBytes),
        keyId: key.keyId,
      }
    } else if (createDidOptions.network === Network.Indicio_Demonet) {
      body = {
        network: 'demonet',
        did,
        verkey: TypedArrayEncoder.toBase58(publicKeyBytes),
        keyId: key.keyId,
      }
    } else {
      throw new BadRequestError('Please provide a valid did method')
    }
    return body
  }

  private async importDid(
    agent: AgentType,
    didMethod: string,
    did: string,
    seed: string,
    privateKey?: string,
    keyId?: string,
  ) {
    let _keyId: string

    if (!keyId) {
      const { privateJwk } = privateKey
        ? transformPrivateKeyToPrivateJwk({
            type: {
              crv: 'Ed25519',
              kty: 'OKP',
            },
            privateKey: TypedArrayEncoder.fromString(privateKey),
          })
        : seed
          ? transformSeedToPrivateJwk({
              seed: TypedArrayEncoder.fromString(seed),
              type: {
                crv: 'Ed25519',
                kty: 'OKP',
              },
            })
          : {
              privateJwk: undefined,
            }

      if (!privateJwk) {
        throw new Error('Either privateKey or seed is required')
      }

      const key = await agent.kms.importKey({ privateJwk })
      _keyId = key.keyId
    } else {
      _keyId = keyId
    }

    const completeDid = `${didMethod}:${did}`
    await agent.dids.import({
      did: completeDid,
      keys: [
        {
          kmsKeyId: _keyId,
          didDocumentRelativeKeyId: verkey,
        },
      ],
    })
  }
  public async handleKey(agent: AgentType, didOptions: DidCreate) {
    let did
    let didResponse
    let didDocument

    if (!didOptions.keyType) {
      throw new BadRequestError('keyType is required')
    }
    if (didOptions.keyType === KeyAlgorithm.Bls12381G2) {
      throw new BadRequestError('didOptions.keyType for type "bls12381g2" has been deprecated')
    }
    if (didOptions.keyType === (p521 as KeyAlgorithm)) {
      throw new BadRequestError('didOptions.keyType for type p521 is not supported')
    }

    const normalizedCurve = keyAlgorithmToCurve[didOptions.keyType as KeyAlgorithm]
    if (!(normalizedCurve && supportedKeyTypesDID[DidMethod.Key]?.some((kt) => kt.crv === normalizedCurve))) {
      throw new BadRequestError(`Invalid keyType: ${didOptions.keyType}`)
    }

    if (!didOptions.did) {
      if (didOptions.seed) {
        this.agent.config.logger.info('Creating DID:key with provided seed')
        const privateJwk = transformPrivateKeyToPrivateJwk({
          privateKey: TypedArrayEncoder.fromString(didOptions.seed),
          type: getTypeFromCurve(didOptions.keyType ?? KeyAlgorithm.Ed25519),
        }).privateJwk

        const { keyId, publicJwk } = await agent.kms.importKey({
          privateJwk,
        })

        this.agent.config.logger.info(`This is keyId:::::: ${keyId}`)
        const publicKey = Kms.PublicJwk.fromPublicJwk(publicJwk)

        const didKey = new DidKey(publicKey)
        didDocument = didKey.didDocument
        did = didDocument.id

        const verificationMethodId = didDocument.verificationMethod?.[0]?.id
        const relativeKeyId = verificationMethodId?.split('#')[1]

        this.agent.config.logger.info(`This is did:::::: ${did}`)
        this.agent.config.logger.info(`This is verificationMethodId:::::: ${verificationMethodId}`)

        await agent.dids.import({
          did,
          didDocument,
          overwrite: true,
          keys: [
            {
              didDocumentRelativeKeyId: `#${relativeKeyId}`,
              kmsKeyId: keyId,
            },
          ],
        })
      } else {
        this.agent.config.logger.info('Creating DID:key without seed')
        const { keyId } = await agent.kms.createKey({
          type: getTypeFromCurve(didOptions.keyType ?? KeyAlgorithm.Ed25519),
        })
        this.agent.config.logger.info(`This is did:::::: ${did}`)
        const didCreateResult = await agent.dids.create<KeyDidCreateOptions>({
          method: 'key',
          options: { keyId },
        })
        didDocument = didCreateResult.didState.didDocument
        did = didCreateResult.didState.did
      }
    } else {
      did = didOptions.did
      const createdDid = await agent.dids.getCreatedDids({
        method: DidMethod.Key,
        did: didOptions.did,
      })
      didDocument = createdDid[0]?.didDocument

      await agent.dids.import({
        did,
        overwrite: true,
        didDocument,
      })
    }

    this.agent.config.logger.info(`This is did ${did}`)
    this.agent.config.logger.info(`This is didDocument ${JSON.stringify(didDocument)}`)

    return { did: did, didDocument: didDocument }
  }

  // TODO: Right now we are using seed as privateKey for did creation. Fix this is API payload
  public async handleWeb(agent: AgentType, didOptions: DidCreate) {
    let didDocument: DidDocument
    if (!didOptions.domain) {
      throw new BadRequestError('For create did:web, domain is required')
    }

    if (!didOptions.seed) {
      throw new BadRequestError('Seed is required')
    }

    if (!didOptions.keyType) {
      throw new BadRequestError('keyType is required')
    }

    if (didOptions.keyType !== KeyAlgorithm.Ed25519) {
      throw new BadRequestError('Only ed25519 key type supported')
    }

    const domain = didOptions.domain
    const did = `did:${didOptions.method}:${domain}`
    const keyId = `${did}#key-1`

    let key
    let publicJwk

    if (didOptions.keyType === KeyAlgorithm.Ed25519) {
      const { privateJwk } = transformPrivateKeyToPrivateJwk({
        type: {
          crv: 'Ed25519',
          kty: 'OKP',
        },
        privateKey: TypedArrayEncoder.fromString(didOptions.seed),
      })

      key = await agent.kms.importKey({ privateJwk })

      publicJwk = Kms.PublicJwk.fromPublicJwk(key.publicJwk)
      didDocument = new DidDocumentBuilder(did)
        .addContext('https://w3id.org/security/suites/ed25519-2018/v1')
        .addVerificationMethod(getEd25519VerificationKey2018({ id: keyId, publicJwk, controller: did }))
        .addAuthentication(keyId)
        .addAssertionMethod(keyId)
        .build()
    } else if (didOptions.keyType === KeyAlgorithm.Bls12381G2) {
      // Support for BBS signature is discontinued from credo-ts version 0.6.0
      throw new BadRequestError(`Support for ${KeyAlgorithm.Bls12381G2} has been deprecated`)
    } else {
      throw new BadRequestError('Unsupported key type') // fallback, but this won't hit due to earlier check
    }

    await agent.dids.import({
      did,
      overwrite: true,
      didDocument,
      keys: [
        {
          didDocumentRelativeKeyId: `#key-1`,
          kmsKeyId: key.keyId,
        },
      ],
    })
    return { did, didDocument }
  }

  public async handlePolygon(agent: AgentType, createDidOptions: DidCreate) {
    // need to discuss try catch logic
    const { endpoint, network, privatekey } = createDidOptions

    if (!network) {
      throw new BadRequestError('Network is required for Polygon method')
    }

    const networkName = network?.split(':')[1]

    if (networkName !== 'mainnet' && networkName !== 'testnet') {
      throw new BadRequestError('Invalid network type')
    }
    if (!privatekey || typeof privatekey !== 'string' || !privatekey.trim() || privatekey.length !== 64) {
      throw new BadRequestError('Invalid private key or key not supported')
    }

    const createDidResponse = await agent.dids.create<PolygonDidCreateOptions>({
      method: DidMethod.Polygon,
      options: {
        network: networkName,
        endpoint,
      },
      secret: {
        privateKey: TypedArrayEncoder.fromHex(`${privatekey}`),
      },
    })

    // The Polygon registrar never throws on failure; it returns didState.state === 'failed' with a
    // reason. Surface that reason instead of silently returning an undefined did, so partial-state
    // failures (e.g. ledger write failed) are reported and the caller can safely retry.
    if (createDidResponse?.didState?.state !== 'finished') {
      const reason = (createDidResponse?.didState as { reason?: string })?.reason ?? 'Unknown error'
      throw new InternalServerError(`Failed to create did:polygon: ${reason}`)
    }

    const didResponse = {
      did: createDidResponse?.didState?.did,
      didDocument: createDidResponse?.didState?.didDocument,
    }
    return didResponse
  }

  public async handleEthereum(agent: AgentType, createDidOptions: DidCreate) {
    const { endpoint, network, privatekey } = createDidOptions
    const networkName = network?.split(':')[1]
    if (networkName !== 'mainnet' && networkName !== 'sepolia') {
      throw new BadRequestError('Invalid network type')
    }
    if (!privatekey || typeof privatekey !== 'string' || !privatekey.trim() || privatekey.length !== 64) {
      throw new BadRequestError('Invalid private key or key not supported')
    }

    const createDidResponse = await agent.dids.create<EthereumDidCreateOptions>({
      method: DidMethod.Ethereum,
      options: {
        network: networkName === NetworkTypes.Mainnet ? '' : networkName,
        endpoint,
      },
      secret: {
        privateKey: TypedArrayEncoder.fromHex(`${privatekey}`),
      },
    })

    // The Ethereum registrar never throws on failure; it returns didState.state === 'failed' with a
    // reason. Surface that reason instead of silently returning an undefined did, so partial-state
    // failures (e.g. RPC/ledger write failed) are reported and the caller can safely retry.
    if (createDidResponse?.didState?.state !== 'finished') {
      const reason = (createDidResponse?.didState as { reason?: string })?.reason ?? 'Unknown error'
      throw new InternalServerError(`Failed to create did:ethr: ${reason}`)
    }

    // EthrDidRegistrar.create() unconditionally saves a new DidRecord -- it never checks whether
    // one already exists for the same derived identity (the same private key always derives the
    // same did:ethr address). Calling this twice for the same tenant with the same private key
    // silently leaves two "created" DidRecord rows for the identical did. That's invisible here --
    // create() itself never fails -- but Credo's own findCreatedDid (findSingleByQuery) throws
    // "Multiple records found" the next time anything looks the DID up, e.g. the Ethereum module's
    // getPublicKeyFromDid during schema creation/migration. Confirmed in production. Detect it
    // immediately, roll back the row this call just added, and fail loudly here instead of days
    // later on an unrelated schema call.
    const createdDid = createDidResponse.didState.did as string
    const didRepository = agent.dependencyManager.resolve(DidRepository)
    const matchingRecords = await didRepository.findByQuery(agent.context, {
      $or: [{ alternativeDids: [createdDid] }, { did: createdDid }],
      role: DidDocumentRole.Created,
    })
    if (1 < matchingRecords.length) {
      // createdAt alone isn't a reliable ordering key -- concurrent DidRecords can share the same
      // millisecond-resolution timestamp, and Askar's underlying scan gives no ordering guarantee.
      // Without a tie-breaker, two racing calls seeing the same records in opposite orders could
      // each pick a *different* record to delete, deleting both and leaving none. `id` is unique
      // and stable regardless of query order, so it's a safe deterministic tie-breaker.
      const duplicates = [...matchingRecords]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(1)
      for (const duplicate of duplicates) {
        try {
          await didRepository.delete(agent.context, duplicate)
        } catch (error) {
          // Two genuinely concurrent calls for the same private key can both land here and both
          // pick the same duplicate to delete -- whichever loses that race hits "record not found",
          // not a real failure. Swallow only that case so the loser still gets the intended 400
          // below instead of an unrelated 404 from ErrorHandlingService mapping RecordNotFoundError.
          if (!(error instanceof RecordNotFoundError)) throw error
        }
      }
      throw new BadRequestError(
        `This ethereum DID already exists in this wallet: ${createdDid}. The supplied private key was already used to create a did:ethr DID here.`,
      )
    }

    const didResponse = {
      did: createDidResponse?.didState?.did,
      didDocument: createDidResponse?.didState?.didDocument,
    }
    return didResponse
  }

  // isDefault, not a separate route: mirrors how the default is tracked (a tag on the same
  // DidRecord, not a separate resource), and keeps the filter query-string based like every other
  // list endpoint in this file's siblings. Answers platform #71's follow-up finding that there was
  // no read path at all for isDefault on this repo -- platform's own gateway route now forwards
  // here instead of failing loudly, see the platform #71 review.
  @Get('/')
  public async getDids(@Request() request: Req, @Query('isDefault') isDefault?: boolean) {
    try {
      if (isDefault) {
        const didRepository = request.agent.dependencyManager.resolve(DidRepository)
        return await didRepository.findByQuery(request.agent.context, { isDefault: true })
      }
      const createdDids = await request.agent.dids.getCreatedDids()
      return createdDids
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
