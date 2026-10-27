// A signed consent PDF must not print an empty labelled line.
//
// New-client intake stopped collecting pt_clients.occupation, so a blank
// value is normal. The generator used to draw "Occupation:" with an empty
// value anyway, leaving a labelled blank on the record. Blank is omitted; a
// recorded value still prints.
//
// Parses the real PDF rather than asserting on source text, for the same
// reason ai.textExtract.test.js does: the failure mode is what the document
// actually says.

let mockBuffer;

jest.mock('../lib/fileStorage', () => ({
  saveFile: jest.fn(async (_category, _filename, buffer) => {
    mockBuffer = buffer;
    return '/uploads/informed-consent/pdf/test.pdf';
  }),
}));

const { generateInformedConsentPdf } = require('../lib/informedConsentPdf');
const { extractText } = require('../lib/ai/textExtract');

const record = (over = {}) => ({
  id: 'ic1',
  version: 1,
  status: 'completed',
  full_name: 'Mina Rao',
  dob: '1996-01-01',
  gender: 'female',
  mobile: '0400000000',
  email: 'mina@example.test',
  address: '1 Test St',
  occupation: null,
  emergency_contact: 'Rao',
  emergency_phone: '0400000001',
  acknowledgements: {},
  ...over,
});

describe('informed consent PDF client details', () => {
  test('a blank occupation is omitted', async () => {
    await generateInformedConsentPdf(record());
    const text = await extractText(mockBuffer, 'application/pdf');
    expect(text).toContain('Client Details');
    expect(text).not.toContain('Occupation:');
  }, 30000);

  test('a recorded occupation still prints', async () => {
    await generateInformedConsentPdf(record({ occupation: 'Physiotherapist' }));
    const text = await extractText(mockBuffer, 'application/pdf');
    expect(text).toContain('Occupation:');
    expect(text).toContain('Physiotherapist');
  }, 30000);
});
