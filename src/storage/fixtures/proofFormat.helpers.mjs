import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig } from '@credo-ts/core'
import {
  DidCommAttachment,
  DidCommMessageRecord,
  DidCommMessageRepository,
  DidCommMessageRole,
  DidCommProofV2Protocol,
  DidCommProofFormatSpec,
  DidCommProposePresentationV2Message,
  DidCommRequestPresentationV2Message,
  DidCommPresentationV2Message,
} from '@credo-ts/didcomm'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

export const kinds = [
  ['proposal', DidCommProposePresentationV2Message, 'proposalAttachments'],
  ['request', DidCommRequestPresentationV2Message, 'requestAttachments'],
  ['presentation', DidCommPresentationV2Message, 'presentationAttachments'],
]
export function message(kind, value = { synthetic: true }) {
  const [, Message, attachments] = kinds.find(([name]) => name === kind)
  return new Message({
    formats: [new DidCommProofFormatSpec({ attachmentId: 'data', format: 'fixture/json' })],
    [attachments]: [new DidCommAttachment({ id: 'data', data: { json: value } })],
  })
}
export function protocol() {
  return new DidCommProofV2Protocol({
    proofFormats: [{ formatKey: 'fixture', supportsFormat: (format) => format === 'fixture/json' }],
  })
}
// Reproduce the original three stock lookups using the compatibility path. No cache.
export function baselineProtocol() {
  const baseline = protocol()
  baseline.findProposalMessage = (...args) =>
    DidCommProofV2Protocol.prototype.findProposalMessage.call(baseline, ...args)
  return baseline
}
export async function fixture(postgresPort) {
  if (postgresPort !== undefined && (!Number.isInteger(postgresPort) || postgresPort < 1 || postgresPort > 65535))
    throw new Error('Invalid local fixture port')
  const directory = await mkdtemp(join(tmpdir(), 'proof-format-'))
  const databaseName = `proof_fixture_${randomUUID().replaceAll('-', '')}`
  let store
  try {
    store = await Store.provision({
      uri:
        postgresPort === undefined
          ? `sqlite://${join(directory, 'wallet.db')}`
          : `postgres://fixture:fixture@127.0.0.1:${postgresPort}/${databaseName}?max_connections=8`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: false,
      profile: 'tenant-a',
    })
    await store.createProfile('tenant-b')
    const storage = new AskarStorageService({
      async getInitializedStoreWithProfile(context) {
        return { store, profile: context.contextCorrelationId }
      },
      async withSession(context, operation) {
        const session = await store.session(context.contextCorrelationId).open()
        try {
          return await operation(session)
        } finally {
          await session.close()
        }
      },
    })
    const queries = []
    const find = storage.findByQuery.bind(storage)
    storage.findByQuery = async (...args) => {
      const records = await find(...args)
      queries.push({
        profile: args[0].contextCorrelationId,
        query: args[2],
        options: args[3],
        returned: records.length,
      })
      return records
    }
    const repository = new DidCommMessageRepository(storage, { emit() {} })
    const contexts = new Map()
    function context(profile = 'tenant-a') {
      if (!contexts.has(profile))
        contexts.set(profile, {
          contextCorrelationId: profile,
          dependencyManager: { isRegistered: () => false, resolve: () => repository },
          resolve: () => new CacheModuleConfig({ useCachedStorageService: false }),
        })
      return contexts.get(profile)
    }
    async function save(kind, value, proofId = 'proof', profile = 'tenant-a', role = DidCommMessageRole.Receiver) {
      const record = new DidCommMessageRecord({
        associatedRecordId: proofId,
        message: message(kind, value).toJSON(),
        role,
      })
      await repository.save(context(profile), record)
      return record
    }
    return {
      databaseName,
      store,
      repository,
      storage,
      queries,
      context,
      save,
      async close() {
        try {
          await store.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try {
      if (store) await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
}
