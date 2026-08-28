/**
 * Regression guard for a real bug: adding a field to `jsonLdCredentialOptions` in types.ts is not
 * enough on its own -- the generated `src/routes/routes.ts` and `swagger.json` must be regenerated
 * (`yarn tsoa`) too, or the field is silently rejected as an "excess property" (422) at the HTTP
 * layer under this repo's `noImplicitAdditionalProperties: "throw-on-extras"` config, even though
 * the controller itself accepts it fine. Confirmed in review: `expirationDate` was added to
 * types.ts, but the generated artifacts were never regenerated to match, until this fix.
 * `AgentController.selfAttestedCredential.spec.ts` calls the controller method directly, bypassing
 * tsoa's request validation entirely, so it can't catch this class of bug on its own.
 *
 * This doesn't spin up the real Express app/tsoa validator (that needs the real AgentController,
 * which pulls in cliAgent's native-binding module graph -- see AgentController.
 * selfAttestedCredential.spec.ts's own comment for why that's currently unworkable in one test
 * file). Instead it checks swagger.json directly -- generated from the same source tsoa's request
 * validator is driven from -- so a field added to types.ts without regenerating fails this test
 * immediately, long before it can reach production as a silent 422.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('jsonLdCredentialOptions — generated artifacts stay in sync with types.ts', () => {
  it('includes every field declared on the jsonLdCredentialOptions interface', () => {
    const swagger = JSON.parse(readFileSync(join(__dirname, '../swagger.json'), 'utf-8')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
    }
    const properties = Object.keys(swagger.components.schemas.jsonLdCredentialOptions.properties ?? {})

    expect(properties.sort()).toEqual(
      ['@context', 'type', 'credentialSubject', 'proofType', 'expirationDate'].sort(),
    )
  })
})
