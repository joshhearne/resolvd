// decryptRow alias handling: a joined column from an encrypted table
// (e.g. companies.name AS company_name) must decrypt even when the row's
// own table has no sensitive columns (assets, consumables), and the
// *_enc payload must never be left on the response.

import { describe, it, expect, beforeAll } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
});

describe('decryptRow aliases', () => {
  it('decrypts an alias on a table with no field map', async () => {
    const { encrypt } = require('../services/crypto');
    const { decryptRow } = require('../services/fields');
    const row = { id: 1, hostname: 'PC01', company_name: null, company_name_enc: await encrypt('Acme Ltd', 'companies.name') };
    await decryptRow('assets', row, { aliases: { company_name: 'companies.name' } });
    expect(row.company_name).toBe('Acme Ltd');
    expect('company_name_enc' in row).toBe(false);
  });

  it('keeps the plaintext and strips a null *_enc when encryption is off', async () => {
    const { decryptRow } = require('../services/fields');
    const row = { id: 2, vendor_company_name: 'Plain Co', vendor_company_name_enc: null };
    await decryptRow('consumables', row, { aliases: { vendor_company_name: 'companies.name' } });
    expect(row.vendor_company_name).toBe('Plain Co');
    expect('vendor_company_name_enc' in row).toBe(false);
  });

  it('still decrypts own columns alongside aliases', async () => {
    const { encrypt } = require('../services/crypto');
    const { decryptRow } = require('../services/fields');
    const row = {
      name: null, name_enc: await encrypt('Jo Bloggs', 'contacts.name'),
      company_name: null, company_name_enc: await encrypt('Acme Ltd', 'companies.name'),
    };
    await decryptRow('contacts', row, { aliases: { company_name: 'companies.name' } });
    expect(row).toEqual({ name: 'Jo Bloggs', company_name: 'Acme Ltd' });
  });
});
