import { signLicence } from '../../tools/issue-licence';
import { TEST_LICENCE_PRIVATE_JWK } from '../fixtures/licence-test-key';

/** A Pro licence key trusted by e2e builds (`wxt build --mode e2e`) only. */
export async function testLicenceKey(opts: { months?: number; now?: Date } = {}): Promise<string> {
  return (await signLicence(TEST_LICENCE_PRIVATE_JWK, { org: 'EviCap Test', email: 'tester@example.test', ...opts })).key;
}
