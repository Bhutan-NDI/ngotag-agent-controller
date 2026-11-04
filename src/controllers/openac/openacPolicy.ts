/**
 * The OpenAC PoC policy: "over 18". The holder proves `birth_ymd <= cutoff` where cutoff is today minus 18 years as
 * YYYYMMDD. The cutoff is inclusive: someone born exactly 18 years ago today is 18 and passes.
 */
import type { PredicateExpression } from 'openac-sdk'

export const POLICY_OVER18 = 'over18'
export type OpenAcPolicy = typeof POLICY_OVER18
export const SUPPORTED_POLICIES: readonly OpenAcPolicy[] = [POLICY_OVER18]

export const BIRTH_CLAIM = 'birth_ymd'
export const MIN_AGE_YEARS = 18

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/**
 * Cutoff birth date as a YYYYMMDD number: `now` (UTC) minus `years`. 29 February minus a number of years that is not
 * a leap year lands on 28 February, so a person born on 29 February turns 18 on 28 February in non-leap years.
 */
export const cutoffYmd = (years: number, now: Date = new Date()): number => {
  const year = now.getUTCFullYear() - years
  const month = now.getUTCMonth()
  let day = now.getUTCDate()
  if (month === 1 && day === 29 && !isLeapYear(year)) day = 28
  return year * 10000 + (month + 1) * 100 + day
}

/**
 * The predicate for a policy. The literal is a string because the Prepare circuit only accepts a `uint` literal in
 * that form (Step 0 finding Q4); `birth_ymd` is a string in the credential for the same reason.
 */
export const policyPredicate = (policy: OpenAcPolicy, now: Date = new Date()): PredicateExpression => {
  if (policy !== POLICY_OVER18) throw new Error(`Unsupported policy: ${String(policy)}`)
  return { claim: BIRTH_CLAIM, op: '<=', value: String(cutoffYmd(MIN_AGE_YEARS, now)), format: 'uint' }
}

export const isSupportedPolicy = (policy: unknown): policy is OpenAcPolicy =>
  typeof policy === 'string' && (SUPPORTED_POLICIES as readonly string[]).includes(policy)
