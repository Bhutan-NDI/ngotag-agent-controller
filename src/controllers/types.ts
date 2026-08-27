import type { RecordId } from './examples'
import type {
  AnonCredsCredentialDefinition,
  AnonCredsDidCommCredentialFormat,
  AnonCredsDidCommProofFormat,
  LegacyIndyCredentialFormat,
  LegacyIndyDidCommProofFormat,
  RegisterCredentialDefinitionReturnStateAction,
  RegisterCredentialDefinitionReturnStateFailed,
  RegisterCredentialDefinitionReturnStateFinished,
  RegisterCredentialDefinitionReturnStateWait,
  RegisterSchemaReturnStateAction,
  RegisterSchemaReturnStateFailed,
  RegisterSchemaReturnStateFinished,
  RegisterSchemaReturnStateWait,
} from '@credo-ts/anoncreds'
import type {
  DidResolutionMetadata,
  DidDocumentMetadata,
  DidRegistrationExtraOptions,
  DidDocument,
  DidRegistrationSecretOptions,
  DidResolutionOptions,
  JsonObject,
  W3cJsonLdVerifyCredentialOptions,
  DataIntegrityProofOptions,
  W3cJsonLdSignCredentialOptions,
  W3cCredential,
  W3cCredentialSubject,
  X509CertificateIssuerAndSubjectOptions,
  SingleOrArray,
} from '@credo-ts/core'
import type {
  JsonCredential,
  ReceiveOutOfBandInvitationConfig,
  OutOfBandDidCommService,
  DidCommCredentialFormatPayload,
  DidCommAutoAcceptCredential,
  DidCommProofExchangeRecord,
  DidCommJsonLdCredentialFormat,
  DidCommCredentialExchangeRecord,
  DidCommAutoAcceptProof,
  DidCommHandshakeProtocol,
  DidCommMessage,
  DidCommRouting,
  DidCommAttachment,
  DidCommProofFormatPayload,
  DidCommDifPresentationExchangeProofFormat,
} from '@credo-ts/didcomm'
import type { KeyAlgorithm } from '@openwallet-foundation/askar-nodejs'
import type { DIDDocument } from 'did-resolver'

import { DidMethod, type CustomHandshakeProtocol } from '../enums'

export type CustomTenantConfig = { label: string } & {
  connectionImageUrl?: string
}

export interface AgentInfo {
  label: string
  endpoints: string[]
  isInitialized: boolean
  publicDid: void
}

export interface AgentToken {
  token: string
}

export enum CredentialState {
  ProposalSent = 'proposal-sent',
  ProposalReceived = 'proposal-received',
  OfferSent = 'offer-sent',
  OfferReceived = 'offer-received',
  Declined = 'declined',
  RequestSent = 'request-sent',
  RequestReceived = 'request-received',
  CredentialIssued = 'credential-issued',
  CredentialReceived = 'credential-received',
  Done = 'done',
  Abandoned = 'abandoned',
}

export enum CredentialRole {
  Issuer = 'issuer',
  Holder = 'holder',
}

export interface AgentMessageType {
  '@id': string
  '@type': string
  [key: string]: unknown
}

export interface DidResolutionResultProps {
  didResolutionMetadata: DidResolutionMetadata
  didDocument: DIDDocument | null
  didDocumentMetadata: DidDocumentMetadata
}

export interface ProofRequestMessageResponse {
  message: string
  proofRecord: DidCommProofExchangeRecord
}

// type CredentialFormats = [CredentialFormat]
type CredentialFormats = [LegacyIndyCredentialFormat, AnonCredsDidCommCredentialFormat, DidCommJsonLdCredentialFormat]
type ProofFormats = [
  LegacyIndyDidCommProofFormat,
  AnonCredsDidCommProofFormat,
  DidCommDifPresentationExchangeProofFormat,
]

enum ProtocolVersion {
  v1 = 'v1',
  v2 = 'v2',
}
export interface ProposeCredentialOptions {
  protocolVersion: ProtocolVersion
  credentialFormats: DidCommCredentialFormatPayload<CredentialFormatType[], 'createProposal'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
  connectionId: RecordId
}

export interface AcceptCredentialProposalOptions {
  credentialExchangeRecordId: string
  credentialFormats?: DidCommCredentialFormatPayload<CredentialFormats, 'acceptProposal'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
}

export interface CreateOfferOptions {
  protocolVersion: ProtocolVersion
  connectionId: RecordId
  credentialFormats: DidCommCredentialFormatPayload<CredentialFormats, 'createOffer'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
  goalCode?: string
  goal?: string
  parentThreadId?: string
}

type CredentialFormatType =
  | LegacyIndyCredentialFormat
  | DidCommJsonLdCredentialFormat
  | AnonCredsDidCommCredentialFormat

export interface CreateOfferOobOptions {
  protocolVersion: ProtocolVersion
  credentialFormats: DidCommCredentialFormatPayload<CredentialFormatType[], 'createOffer'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
  goalCode?: string
  parentThreadId?: string
  willConfirm?: boolean
  label?: string
  imageUrl?: string
  recipientKey?: string
  invitationDid?: string
}
export interface CredentialCreateOfferOptions {
  credentialRecord: DidCommCredentialExchangeRecord
  credentialFormats: JsonCredential
  options: any
  attachmentId?: string
}

export interface CreateProofRequestOobOptions {
  protocolVersion: string
  proofFormats: any
  goalCode?: string
  parentThreadId?: string
  willConfirm?: boolean
  autoAcceptProof?: DidCommAutoAcceptProof
  comment?: string
  label?: string
  imageUrl?: string
  recipientKey?: string
  invitationDid?: string
}

export interface OfferCredentialOptions {
  credentialFormats: {
    indy: {
      credentialDefinitionId: string
      attributes: {
        name: string
        value: string
      }[]
    }
  }
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
  connectionId: string
}

export interface V2OfferCredentialOptions {
  protocolVersion: string
  connectionId: string
  credentialFormats: {
    indy: {
      credentialDefinitionId: string
      attributes: {
        name: string
        value: string
      }[]
    }
  }
  autoAcceptCredential: string
}

export interface AcceptCredential {
  credentialExchangeRecordId: RecordId
}

export interface CredentialOfferOptions {
  credentialExchangeRecordId: RecordId
  credentialFormats?: DidCommCredentialFormatPayload<CredentialFormats, 'acceptOffer'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
}

export interface AcceptCredentialRequestOptions {
  credentialExchangeRecordId: RecordId
  credentialFormats?: DidCommCredentialFormatPayload<CredentialFormats, 'acceptRequest'>
  autoAcceptCredential?: DidCommAutoAcceptCredential
  comment?: string
}

type ReceiveOutOfBandInvitationProps = Omit<ReceiveOutOfBandInvitationConfig, 'routing'>

export interface ReceiveInvitationProps extends ReceiveOutOfBandInvitationProps {
  invitation: OutOfBandInvitationSchema
}

export interface ReceiveInvitationByUrlProps extends ReceiveOutOfBandInvitationProps {
  invitationUrl: string
}

export interface AcceptInvitationConfig {
  autoAcceptConnection?: boolean
  reuseConnection?: boolean
  label: string
  alias?: string
  imageUrl?: string
  mediatorId?: string
}

export interface OutOfBandInvitationSchema {
  '@id'?: string
  '@type': string
  label: string
  goalCode?: string
  goal?: string
  accept?: string[]
  handshake_protocols?: CustomHandshakeProtocol[]
  services: Array<OutOfBandDidCommService | string>
  imageUrl?: string
}

export interface ConnectionInvitationSchema {
  id?: string
  '@type': string
  label: string
  did?: string
  recipientKeys?: string[]
  serviceEndpoint?: string
  routingKeys?: string[]
  imageUrl?: string
}

export interface RequestProofOptions {
  connectionId: string
  protocolVersion: string
  proofFormats: any
  comment: string
  autoAcceptProof: DidCommAutoAcceptProof
  goalCode?: string
  parentThreadId?: string
  willConfirm?: boolean
}

// TODO: added type in protocolVersion
export interface RequestProofProposalOptions {
  protocolVersion: ProtocolVersion
  connectionId: string
  proofFormats: DidCommProofFormatPayload<ProofFormats, 'createProposal'>
  goalCode?: string
  parentThreadId?: string
  autoAcceptProof?: DidCommAutoAcceptProof
  comment?: string
}

export interface AcceptProofProposal {
  proofExchangeRecordId: string
  proofFormats: DidCommProofFormatPayload<ProofFormats, 'acceptProposal'>
  comment?: string
  autoAcceptProof?: DidCommAutoAcceptProof
  goalCode?: string
  willConfirm?: boolean
}

export interface GetTenantAgentOptions {
  tenantId: string
}

export interface DidCreateOptions {
  method?: string
  did?: string
  options?: DidRegistrationExtraOptions
  secret?: DidRegistrationSecretOptions
  didDocument?: DidDocument
  seed?: any
}

export interface ResolvedDid {
  didUrl: string
  options?: DidResolutionOptions
}

export interface DidCreate {
  keyType?: KeyAlgorithm
  seed?: string
  domain?: string
  method: string
  network?: string
  did?: string
  role?: string
  endorserDid?: string
  didDocument?: DidDocument
  privatekey?: string
  endpoint?: string
  // Marks the newly created DID as this wallet's default issuer DID. Tracked as an `isDefault`
  // tag on the DID's own DidRecord (booleans round-trip through AskarStorageService as "1"/"0"),
  // and read back via DidRepository.findByQuery({ isDefault: true }) — see DidController.writeDid
  // for the clear-previous-default bookkeeping and AgentController's self-attested lookup for the
  // read path.
  isDefault?: boolean
}

export interface CreateTenantOptions {
  config: Omit<CustomTenantConfig, 'walletConfig'>
}

// export type WithTenantAgentCallback<AgentModules extends ModulesMap> = (
//   tenantAgent: TenantAgent<AgentModules>
// ) => Promise<void>

export interface WithTenantAgentOptions {
  tenantId: string
  method: string
  payload?: any
}

export interface ReceiveConnectionsForTenants {
  tenantId: string
  invitationId?: string
}

export interface CreateInvitationOptions {
  label?: string
  alias?: string
  imageUrl?: string
  goalCode?: string
  goal?: string
  handshake?: boolean
  handshakeProtocols?: DidCommHandshakeProtocol[]
  messages?: DidCommMessage[]
  multiUseInvitation?: boolean
  autoAcceptConnection?: boolean
  routing?: DidCommRouting
  appendedAttachments?: DidCommAttachment[]
  invitationDid?: string
}

//todo:Add transaction type
export interface EndorserTransaction {
  transaction: string | Record<string, unknown>
  endorserDid: string
}

export interface DidNymTransaction {
  did: string
  nymRequest: string
}

//todo:Add endorsedTransaction type
export interface WriteTransaction {
  endorsedTransaction: string
  endorserDid?: string
  schema?: {
    issuerId: string
    name: string
    version: string
    attributes: string[]
  }
  credentialDefinition?: {
    schemaId: string
    issuerId: string
    tag: string
    value: unknown
    type: string
  }
}
export interface RecipientKeyOption {
  recipientKey?: string
}

export interface CreateSchemaInput {
  issuerId: string
  name: string
  version: string
  attributes: string[]
  endorse?: boolean
  endorserDid?: string
}

export interface SchemaMetadata {
  did: string
  schemaId: string
  schemaTxnHash?: string
  schemaUrl?: string
}
/**
 * @example "ea4e5e69-fc04-465a-90d2-9f8ff78aa71d"
 */
export type ThreadId = string

export type SignDataOptions = {
  data: string
  // FIXME: Check type
  keyType: any
  publicKeyBase58: string
  did?: string
  method?: string
}

export type VerifyDataOptions = {
  /**
   * DID whose authentication key verifies the signature. The verification key is
   * resolved from the DID Document, never taken from the request body.
   */
  did: string
  /** Signed data, base64 encoded */
  data: string
  /** Signature to verify, base64 encoded */
  signature: string
  /** Key type hint (informational, e.g. "ed25519") */
  keyType?: string
  /** Optional DID method hint (informational) */
  method?: string
  /** Optional; ignored for verification — the DID-resolved key is always used */
  publicKeyBase58?: string
}

export interface jsonLdCredentialOptions {
  '@context': Array<string | JsonObject>
  type: Array<string>
  credentialSubject: SingleOrArray<JsonObject>
  proofType: string
  // ISO 8601. Optional in the VC data model, but W3cCredential's constructor always sets its own
  // expirationDate field (even to undefined), and @digitalcredentials/vc's issuer checks
  // 'expirationDate' in credential rather than its truthiness -- so signing throws unless a real
  // date reaches it. Defaulted server-side when omitted; see AgentController.
  expirationDate?: string
}

// The actual runtime shape of AgentController.createW3cSelfAttestedCredential's response:
// JsonTransformer.toJSON() of the stored W3cCredentialRecord (id, createdAt, credentialInstances,
// plus Credo's own dynamic tag fields -- issuerId, subjectIds, etc. -- not individually modeled
// here since JsonTransformer.toJSON<T>()'s own declared return type is just Record<string, any>,
// there's nothing more specific upstream to model against), plus a `credential` field added for
// back-compat with consumers that read response.credential directly (0.6.2's W3cCredentialRecord
// only exposes credentialInstances via JsonTransformer.toJSON). Declared as this endpoint's return
// type so tsoa's generated OpenAPI schema actually reflects the record id/credentialInstances a
// caller relies on, instead of documenting only `credential` -- all the previous no-return-type
// schema could tell client-generation tooling to expect. The index signature is deliberate, not a
// cop-out: it documents that Credo's own dynamic tag fields are real and present, just not
// individually enumerable from this endpoint's own code. See the #75 review.
export interface SelfAttestedW3cCredentialResponse {
  id: string
  createdAt: string
  // Array of wrapper objects, not credential objects directly -- W3cCredentialRecord.fromCredential
  // populates this as [{ credential: credential.encoded }]. `credential` is JsonObject | string
  // since W3cCredentialRecord.encoded can be a JWT string for ClaimFormat.JwtVc, not just an
  // expanded JSON-LD object. See the #75 review.
  credentialInstances: Array<{ credential: JsonObject | string }>
  credential: JsonObject
  [key: string]: unknown
}

export interface credentialPayloadToSign {
  issuerDID: string
  method: string
  credential: jsonLdCredentialOptions // TODO: add support for other credential format
}
export interface SafeW3cJsonLdVerifyCredentialOptions extends W3cJsonLdVerifyCredentialOptions {
  // Ommited due to issues with TSOA
  // FIXME: Check type
  proof: SingleOrArray<any | DataIntegrityProofOptions>
}

export type ExtensibleW3cCredentialSubject = W3cCredentialSubject & {
  [key: string]: unknown
}

export type ExtensibleW3cCredential = W3cCredential & {
  [key: string]: unknown
  credentialSubject: SingleOrArray<ExtensibleW3cCredentialSubject>
}

export type CustomW3cJsonLdSignCredentialOptions = Omit<W3cJsonLdSignCredentialOptions, 'format'> & {
  [key: string]: unknown
}

export type DisclosureFrame = {
  [key: string]: boolean | DisclosureFrame
}

export interface BasicX509CreateCertificateConfig extends X509CertificateIssuerAndSubjectOptions {
  // FIXME: Check type
  keyType: any
  issuerAlternativeNameURL: string
}

export interface X509ImportCertificateOptionsDto {
  /*
        X.509 certificate in base64 string format
    */
  certificate: string

  /*
   Private key in base64 string format
   */
  privateKey?: string

  // FIXME: Check type
  keyType: any
}

export const supportedKeyTypesDID: Record<DidMethod, readonly { kty: string; crv: string }[]> = {
  [DidMethod.Indy]: [{ kty: 'OKP', crv: 'Ed25519' }],

  [DidMethod.Peer]: [
    { kty: 'OKP', crv: 'Ed25519' },
    { kty: 'OKP', crv: 'X25519' },
  ],

  [DidMethod.Key]: [
    { kty: 'OKP', crv: 'Ed25519' },
    { kty: 'OKP', crv: 'X25519' },
    { kty: 'EC', crv: 'P-256' },
    { kty: 'EC', crv: 'P-384' },
    { kty: 'EC', crv: 'P-521' },
    { kty: 'EC', crv: 'secp256k1' },
  ],

  [DidMethod.Web]: [
    { kty: 'OKP', crv: 'Ed25519' },
    { kty: 'OKP', crv: 'X25519' },
    { kty: 'EC', crv: 'P-256' },
    { kty: 'EC', crv: 'secp256k1' },
  ],

  [DidMethod.Polygon]: [{ kty: 'EC', crv: 'secp256k1' }],

  [DidMethod.Ethereum]: [{ kty: 'EC', crv: 'secp256k1' }],
}

export type Curve = 'Ed25519' | 'X25519' | 'P-256' | 'P-384' | 'P-521' | 'secp256k1'

export type OkpCurve = 'Ed25519' | 'X25519'
export type EcCurve = 'P-256' | 'P-384' | 'P-521' | 'secp256k1'

export type OkpType = {
  kty: 'OKP'
  crv: 'Ed25519' | 'X25519'
}

export type EcType = {
  kty: 'EC'
  crv: 'P-256' | 'P-384' | 'P-521' | 'secp256k1'
}

export interface SchemaResponseDTO {
  schemaId: string
  schema?: {
    issuerId: string
    name: string
    version: string
    attrNames: string[]
  }
  resolutionMetadata: Record<string, unknown> // Use Record or explicitly define what you need
  schemaMetadata: Record<string, unknown>
}

export interface RegisterSchemaReturn {
  jobId?: string
  schemaState:
    | RegisterSchemaReturnStateWait
    | RegisterSchemaReturnStateAction
    | RegisterSchemaReturnStateFinished
    | RegisterSchemaReturnStateFailed
  schemaMetadata: Record<string, unknown>
  registrationMetadata: Record<string, unknown>
}

export interface GetCredentialDefinitionReturn {
  credentialDefinition?: AnonCredsCredentialDefinition
  credentialDefinitionId: string
  resolutionMetadata: Record<string, unknown>
  credentialDefinitionMetadata: Record<string, unknown>
}

export type CredentialDefinitionStates =
  | RegisterCredentialDefinitionReturnStateWait
  | RegisterCredentialDefinitionReturnStateAction
  | RegisterCredentialDefinitionReturnStateFinished
  | RegisterCredentialDefinitionReturnStateFailed

export interface RegisterCredentialDefinitionReturn {
  jobId?: string
  credentialDefinitionState: CredentialDefinitionStates
  credentialDefinitionMetadata: Record<string, unknown>
  registrationMetadata: Record<string, unknown>
}
