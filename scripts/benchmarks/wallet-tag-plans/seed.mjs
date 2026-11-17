// Seeds a disposable local Askar PostgreSQL wallet shaped like a busy multi-tenant agent: one large
// verifier tenant (connectionless proof requests, their OOB invitations, peer DIDs and messages, plus
// some connections), several small tenants, and the root profile's tenant routing records.
//
// usage: node seed.mjs <port> <database> <manifest.json> [bigTenantExchanges] [smallTenants] [smallTenantExchanges]
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import { DidDocument, DidDocumentRole, DidRecord } from '@credo-ts/core'
import {
  DidCommConnectionRecord,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
  DidCommMessageRecord,
  DidCommMessageRole,
  DidCommOutOfBandInvitation,
  DidCommOutOfBandRecord,
  DidCommOutOfBandRole,
  DidCommOutOfBandState,
  DidCommProofExchangeRecord,
  DidCommProofRole,
  DidCommProofState,
  DidCommRequestPresentationV2Message,
} from '@credo-ts/didcomm'
import { TenantRoutingRecord } from '@credo-ts/tenants'

import { BIG_PROFILE, ROOT_PROFILE, postgresUri, provisionStore, transformFromRecordTagValues } from './fixture.mjs'

// Stored values only have to deserialize into the right record class: queries match on tags, which
// are written separately below. One valid record per class serves as the value template.
const templates = {
  [DidRecord.type]: new DidRecord({
    did: 'did:peer:1ztemplate',
    role: DidDocumentRole.Created,
    didDocument: new DidDocument({ id: 'did:peer:1ztemplate' }),
  }),
  [DidCommConnectionRecord.type]: new DidCommConnectionRecord({
    role: DidCommDidExchangeRole.Responder,
    state: DidCommDidExchangeState.Completed,
  }),
  [DidCommOutOfBandRecord.type]: new DidCommOutOfBandRecord({
    role: DidCommOutOfBandRole.Sender,
    state: DidCommOutOfBandState.AwaitResponse,
    outOfBandInvitation: new DidCommOutOfBandInvitation({ label: 'fixture', services: ['did:peer:2.Ez6template'] }),
  }),
  [DidCommProofExchangeRecord.type]: new DidCommProofExchangeRecord({
    threadId: 'template',
    state: DidCommProofState.RequestSent,
    role: DidCommProofRole.Verifier,
    protocolVersion: 'v2',
  }),
  [DidCommMessageRecord.type]: new DidCommMessageRecord({
    associatedRecordId: 'template',
    role: DidCommMessageRole.Sender,
    message: new DidCommRequestPresentationV2Message({ formats: [], requestAttachments: [] }).toJSON(),
  }),
  [TenantRoutingRecord.type]: new TenantRoutingRecord({
    tenantId: 'template',
    recipientKeyFingerprint: 'z6Mktemplate',
  }),
}
const templateJson = Object.fromEntries(Object.entries(templates).map(([type, record]) => [type, record.toJSON()]))
for (const [type, json] of Object.entries(templateJson)) {
  if (!json) throw new Error(`No value template for ${type}`)
}

const [port, database, manifestPath, bigArg = '60000', smallArg = '6', smallSizeArg = '3000'] = process.argv.slice(2)
const bigExchanges = Number(bigArg)
const smallTenants = Number(smallArg)
const smallExchanges = Number(smallSizeArg)
if (!manifestPath || ![bigExchanges, smallTenants, smallExchanges].every(Number.isSafeInteger)) {
  throw new Error('usage: node seed.mjs <port> <database> <manifest.json> [big] [smallTenants] [smallSize]')
}

const id = (...parts) => createHash('sha256').update(parts.join('/')).digest('hex').slice(0, 32)
const uuid = (...parts) => {
  const h = id(...parts)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const fingerprint = (...parts) => `z6Mk${createHash('sha256').update(parts.join('/')).digest('base64url').slice(0, 44)}`
// Record JSON averages ~700 bytes in an inspected production wallet; the comment field pads to that.
const value = (category, name) => JSON.stringify({ ...templateJson[category], id: name, comment: 'x'.repeat(400) })

const { store, passKey } = await provisionStore(postgresUri(Number(port), database, { maxConnections: 4 }))

async function insertAll(profile, rows) {
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const session = await store.transaction(profile).open()
    try {
      for (const row of rows.slice(offset, offset + 1000)) {
        await session.insert({
          category: row.category,
          name: row.name,
          value: value(row.category, row.name),
          tags: transformFromRecordTagValues(row.tags),
        })
      }
      await session.commit()
    } catch (error) {
      await session.rollback()
      throw error
    }
  }
}

// The raw key of this disposable local fixture wallet, so the benchmark can reopen it.
const manifest = { database, passKey, profiles: {}, root: ROOT_PROFILE }
const routing = []

function tenantRows(profile, exchanges) {
  const rows = []
  const samples = { proofs: [], connections: [] }
  for (let i = 0; i < exchanges; i++) {
    const proofId = uuid(profile, 'proof', i)
    const threadId = uuid(profile, 'thread', i)
    const oobId = uuid(profile, 'oob', i)
    const invitationId = uuid(profile, 'invitation', i)
    const invitationKey = fingerprint(profile, 'invitation-key', i)
    const invitationDid = `did:peer:2.Ez6LS${id(profile, 'agreement', i)}.Vz6Mk${id(profile, 'invitation-did', i)}`
    const done = i % 10 === 0
    rows.push({
      category: DidCommProofExchangeRecord.type,
      name: proofId,
      tags: { threadId, state: done ? 'done' : 'request-sent', role: 'verifier' },
    })
    rows.push({
      category: DidCommMessageRecord.type,
      name: uuid(profile, 'request-message', i),
      tags: {
        role: 'sender',
        associatedRecordId: proofId,
        threadId,
        protocolName: 'present-proof',
        messageName: 'request-presentation',
        protocolMajorVersion: '2',
        protocolMinorVersion: '0',
        messageType: 'https://didcomm.org/present-proof/2.0/request-presentation',
        messageId: threadId,
      },
    })
    if (done) {
      rows.push({
        category: DidCommMessageRecord.type,
        name: uuid(profile, 'presentation-message', i),
        tags: {
          role: 'receiver',
          associatedRecordId: proofId,
          threadId,
          protocolName: 'present-proof',
          messageName: 'presentation',
          protocolMajorVersion: '2',
          protocolMinorVersion: '0',
          messageType: 'https://didcomm.org/present-proof/2.0/presentation',
          messageId: uuid(profile, 'presentation-id', i),
        },
      })
    }
    rows.push({
      category: DidCommOutOfBandRecord.type,
      name: oobId,
      tags: {
        recipientKeyFingerprints: [invitationKey],
        role: 'sender',
        state: 'await-response',
        invitationId,
        threadId: invitationId,
      },
    })
    rows.push({
      category: DidRecord.type,
      name: uuid(profile, 'invitation-did-record', i),
      tags: {
        recipientKeyFingerprints: [invitationKey],
        role: 'created',
        method: 'peer',
        did: invitationDid,
        methodSpecificIdentifier: invitationDid.slice('did:peer:'.length),
      },
    })
    routing.push({ tenantId: profile, recipientKeyFingerprint: invitationKey })
    if (i < 20) samples.proofs.push({ proofId, threadId, invitationId, invitationKey, invitationDid, done })

    // One exchange in ten also has a connection: our peer:1 DID, their DID, both DID records.
    if (i % 10 === 5) {
      const connectionId = uuid(profile, 'connection', i)
      const ourDid = `did:peer:1zQm${id(profile, 'our-did', i)}`
      const theirDid = `did:peer:1zQm${id(profile, 'their-did', i)}`
      const ourKey = fingerprint(profile, 'our-key', i)
      const theirKey = fingerprint(profile, 'their-key', i)
      rows.push({
        category: DidCommConnectionRecord.type,
        name: connectionId,
        tags: {
          state: 'completed',
          role: 'responder',
          threadId: uuid(profile, 'connection-thread', i),
          did: ourDid,
          theirDid,
          outOfBandId: oobId,
          connectionTypes: [],
          previousDids: [],
          previousTheirDids: [],
        },
      })
      for (const [did, key, role] of [
        [ourDid, ourKey, 'created'],
        [theirDid, theirKey, 'received'],
      ]) {
        rows.push({
          category: DidRecord.type,
          name: uuid(profile, 'connection-did-record', role, i),
          tags: {
            recipientKeyFingerprints: [key],
            role,
            method: 'peer',
            did,
            methodSpecificIdentifier: did.slice('did:peer:'.length),
          },
        })
      }
      if (samples.connections.length < 20)
        samples.connections.push({ connectionId, ourDid, theirDid, ourKey, theirKey })
    }
  }
  return { rows, samples }
}

const started = Date.now()
const tenants = [[BIG_PROFILE, bigExchanges]]
for (let t = 0; t < smallTenants; t++) tenants.push([`tenant-small-${t}`, smallExchanges])
for (const [profile, exchanges] of tenants) {
  await store.createProfile(profile)
  const { rows, samples } = tenantRows(profile, exchanges)
  await insertAll(profile, rows)
  manifest.profiles[profile] = { exchanges, items: rows.length, samples }
  process.stdout.write(`seeded ${profile}: ${rows.length} items (${Math.round((Date.now() - started) / 1000)} s)\n`)
}
await insertAll(
  ROOT_PROFILE,
  routing.map((route, i) => ({ category: TenantRoutingRecord.type, name: uuid('routing', i), tags: route })),
)
manifest.rootRoutingRecords = routing.length
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
await store.close()
process.stdout.write(
  `seeded root: ${routing.length} routing records; done in ${Math.round((Date.now() - started) / 1000)} s\n`,
)
