import { readFileSync } from 'fs';
import { join } from 'path';
import { sharp } from './sharp';
import { CV, KYC_DOCUMENT, PHOTO, SPREADSHEET } from './upload-policies';
import { UploadRejectedException } from './upload-rejected.exception';
import {
  ValidateUpload,
  ValidateUploads,
  validateUpload,
} from './validate-upload.pipe';
import {
  jpeg,
  multerFile,
  pdf,
  pdfWithCompressedStream,
  png,
  xlsx,
  xlsxParts,
  zip,
} from './upload-samples.fixture-spec';

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UploadRejectedException)
      return {
        status: error.getStatus(),
        reason: error.details.reason,
        message: error.message,
      };
    throw error;
  }
  return null;
};

describe('validateUpload', () => {
  describe('real files are accepted', () => {
    it('stores a JPEG photo re-encoded, under a clean name with the real extension, and reports its hash', async () => {
      const result = await validateUpload(
        multerFile(await jpeg(), '../../etc/My Selfie.JPEG', 'image/jpeg'),
        PHOTO,
        'selfie',
      );

      expect(result.detectedType).toBe('jpeg');
      expect(result.mimetype).toBe('image/jpeg');
      expect(result.originalname).toBe('My Selfie.jpg');
      expect(result.size).toBe(result.buffer.length);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await sharp(result.buffer).metadata()).format).toBe('jpeg');
    });

    it('accepts a real camera photo (face-match fixture)', async () => {
      const photo = readFileSync(
        join(__dirname, '../../face-match/fixtures/collins-1.jpg'),
      );
      await expect(
        validateUpload(
          multerFile(photo, 'collins.jpg', 'image/jpeg'),
          PHOTO,
          'selfie',
        ),
      ).resolves.toMatchObject({ detectedType: 'jpeg' });
    });

    it('strips EXIF metadata (GPS, camera details) from photos', async () => {
      const withExif = await sharp(await jpeg())
        .withExif({ IFD0: { Copyright: 'camera-serial-123' } })
        .toBuffer();
      expect((await sharp(withExif).metadata()).exif).toBeDefined();

      const result = await validateUpload(
        multerFile(withExif, 'me.jpg', 'image/jpeg'),
        PHOTO,
        'selfie',
      );

      expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
    });

    it('accepts a PNG, a clean PDF, an .xlsx and a CSV under their policies', async () => {
      await expect(
        validateUpload(
          multerFile(await png(), 'p.png', 'image/png'),
          PHOTO,
          'file',
        ),
      ).resolves.toMatchObject({ detectedType: 'png' });
      await expect(
        validateUpload(
          multerFile(pdf(), 'id.pdf', 'application/pdf'),
          KYC_DOCUMENT,
          'file',
        ),
      ).resolves.toMatchObject({ detectedType: 'pdf' });
      await expect(
        validateUpload(
          multerFile(
            await xlsx(),
            'ippis.xlsx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ),
          SPREADSHEET,
          'file',
        ),
      ).resolves.toMatchObject({ detectedType: 'xlsx' });
      await expect(
        validateUpload(
          multerFile(
            Buffer.from('Staff ID,Name\nIP001,Test\n'),
            'ippis.csv',
            'application/vnd.ms-excel',
          ),
          SPREADSHEET,
          'file',
        ),
      ).resolves.toMatchObject({ detectedType: 'csv' });
    });

    it('stores photos as JPEG, whatever was uploaded, but documents in their own format', async () => {
      const asPhoto = await validateUpload(
        multerFile(await png(), 'selfie.png', 'image/png'),
        PHOTO,
        'selfie',
      );
      expect(asPhoto).toMatchObject({
        detectedType: 'png',
        mimetype: 'image/jpeg',
        originalname: 'selfie.jpg',
      });
      expect((await sharp(asPhoto.buffer).metadata()).format).toBe('jpeg');

      const asDocument = await validateUpload(
        multerFile(await png(), 'id.png', 'image/png'),
        KYC_DOCUMENT,
        'file',
      );
      expect(asDocument).toMatchObject({
        detectedType: 'png',
        mimetype: 'image/png',
        originalname: 'id.png',
      });
    });

    it('lets the bytes decide when the upload makes no claim (no extension, generic Content-Type)', async () => {
      await expect(
        validateUpload(
          multerFile(await jpeg(), 'photo', 'application/octet-stream'),
          PHOTO,
          'selfie',
        ),
      ).resolves.toMatchObject({
        detectedType: 'jpeg',
        originalname: 'photo.jpg',
      });
    });

    it('keeps PDFs and spreadsheets byte for byte', async () => {
      const original = pdf();
      expect(
        (
          await validateUpload(
            multerFile(original, 'cv.pdf', 'application/pdf'),
            CV,
            'cv',
          )
        ).buffer.equals(original),
      ).toBe(true);
    });
  });

  describe('disguised and wrong files are rejected with 415', () => {
    it.each([
      [
        'a PDF renamed .jpg and sent as image/jpeg',
        () => multerFile(pdf(), 'photo.jpg', 'image/jpeg'),
        PHOTO,
      ],
      [
        'HTML sent as image/png',
        () =>
          multerFile(
            Buffer.from('<html><script>alert(1)</script></html>'),
            'x.png',
            'image/png',
          ),
        PHOTO,
      ],
      [
        'a PDF on the photo policy',
        () => multerFile(pdf(), 'id.pdf', 'application/pdf'),
        PHOTO,
      ],
      [
        'an image on the CV policy (PDF only)',
        () =>
          multerFile(
            Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
            'cv.jpg',
            'image/jpeg',
          ),
        CV,
      ],
      [
        'HTML that mentions %PDF- later (polyglot)',
        () =>
          multerFile(
            Buffer.concat([Buffer.from('<html>'), pdf()]),
            'cv.pdf',
            'application/pdf',
          ),
        CV,
      ],
      [
        'an executable named .csv',
        () =>
          multerFile(
            Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
            'data.csv',
            'text/csv',
          ),
        SPREADSHEET,
      ],
    ])('%s', async (_name, build, policy) => {
      expect(
        await reasonOf(validateUpload(build(), policy, 'file')),
      ).toMatchObject({ status: 415, reason: 'type-mismatch' });
    });

    it('a real JPEG whose name or Content-Type says PNG', async () => {
      const photo = await jpeg();
      expect(
        await reasonOf(
          validateUpload(multerFile(photo, 'x.png', 'image/jpeg'), PHOTO, 'f'),
        ),
      ).toMatchObject({ status: 415 });
      expect(
        await reasonOf(
          validateUpload(multerFile(photo, 'x.jpg', 'image/png'), PHOTO, 'f'),
        ),
      ).toMatchObject({ status: 415 });
    });

    it('names what is accepted, and never the internals', async () => {
      const result = await reasonOf(
        validateUpload(multerFile(pdf(), 'p.jpg', 'image/jpeg'), PHOTO, 'f'),
      );
      expect(result?.message).toBe('Only JPEG or PNG files are accepted.');
    });

    it('a ZIP that is not a spreadsheet', async () => {
      const notXlsx = zip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
      expect(
        await reasonOf(
          validateUpload(
            multerFile(notXlsx, 'a.xlsx', 'application/zip'),
            SPREADSHEET,
            'file',
          ),
        ),
      ).toMatchObject({ status: 415 });
    });
  });

  describe('size and pixel limits (413)', () => {
    it('a file over the policy size', async () => {
      const big = multerFile(
        Buffer.alloc(6 * 1024 * 1024, 0xff),
        'big.jpg',
        'image/jpeg',
      );
      expect(await reasonOf(validateUpload(big, PHOTO, 'f'))).toMatchObject({
        status: 413,
        reason: 'too-large',
        message: 'The file is larger than 5 MB.',
      });
    });

    it('a tiny PNG that decodes to 400 megapixels (decompression bomb)', async () => {
      const bomb = await sharp({
        create: {
          width: 20000,
          height: 20000,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
        limitInputPixels: false,
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      expect(bomb.length).toBeLessThan(PHOTO.maxBytes);
      expect(
        await reasonOf(
          validateUpload(multerFile(bomb, 'b.png', 'image/png'), PHOTO, 'f'),
        ),
      ).toMatchObject({ status: 413, reason: 'too-large' });
    });
  });

  describe('damaged files (422)', () => {
    it('a truncated JPEG', async () => {
      const photo = readFileSync(
        join(__dirname, '../../face-match/fixtures/collins-1.jpg'),
      );
      const cut = multerFile(
        photo.subarray(0, Math.floor(photo.length / 2)),
        'me.jpg',
        'image/jpeg',
      );
      expect(await reasonOf(validateUpload(cut, PHOTO, 'f'))).toMatchObject({
        status: 422,
        reason: 'undecodable',
      });
    });

    it('a JPEG signature followed by garbage', async () => {
      const fake = multerFile(
        Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          Buffer.alloc(2000, 7),
        ]),
        'me.jpg',
        'image/jpeg',
      );
      expect(await reasonOf(validateUpload(fake, PHOTO, 'f'))).toMatchObject({
        status: 422,
      });
    });

    it('a truncated PDF', async () => {
      expect(
        await reasonOf(
          validateUpload(
            multerFile(pdf().subarray(0, 60), 'cv.pdf', 'application/pdf'),
            CV,
            'cv',
          ),
        ),
      ).toMatchObject({ status: 422, reason: 'undecodable' });
    });

    it('a password-protected PDF', async () => {
      const locked = Buffer.from(
        pdf().toString('latin1').replace('/Size 3/', '/Size 3/Encrypt 5 0 R/'),
        'latin1',
      );
      expect(
        await reasonOf(
          validateUpload(
            multerFile(locked, 'cv.pdf', 'application/pdf'),
            CV,
            'cv',
          ),
        ),
      ).toMatchObject({ status: 422 });
    });

    it('an empty CSV', async () => {
      expect(
        await reasonOf(
          validateUpload(
            multerFile(Buffer.alloc(0), 'a.csv', 'text/csv'),
            SPREADSHEET,
            'f',
          ),
        ),
      ).toMatchObject({ status: 422 });
    });
  });

  describe('dangerous content (422)', () => {
    it.each([
      ['JavaScript', '/OpenAction<</S/JavaScript/JS(app.alert(1))>>'],
      ['a Launch action', '/OpenAction<</S/Launch/F(cmd.exe)>>'],
      ['an embedded file', '/Names<</EmbeddedFiles 9 0 R>>'],
      ['a hex-escaped name (/J#61vaScript)', '/OpenAction<</S/J#61vaScript>>'],
      ['an XFA form', '/AcroForm<</XFA 7 0 R>>'],
    ])('a PDF with %s', async (_name, extra) => {
      const result = await reasonOf(
        validateUpload(
          multerFile(pdf(extra), 'cv.pdf', 'application/pdf'),
          CV,
          'cv',
        ),
      );
      expect(result).toMatchObject({
        status: 422,
        reason: 'dangerous-content',
      });
      expect(result?.message).toMatch(
        /scripts, attachments or interactive content/,
      );
    });

    it('a PDF hiding a Launch action inside a compressed object stream', async () => {
      const hidden = pdfWithCompressedStream('<</S/Launch/F(cmd.exe)>>');
      expect(hidden.toString('latin1')).not.toContain('/Launch');
      expect(
        await reasonOf(
          validateUpload(
            multerFile(hidden, 'cv.pdf', 'application/pdf'),
            CV,
            'cv',
          ),
        ),
      ).toMatchObject({ reason: 'dangerous-content' });
    });

    it('a PDF whose compressed stream is a bomb', async () => {
      const bomb = pdfWithCompressedStream('A'.repeat(101 * 1024 * 1024));
      expect(bomb.length).toBeLessThan(CV.maxBytes);
      expect(
        await reasonOf(
          validateUpload(
            multerFile(bomb, 'cv.pdf', 'application/pdf'),
            CV,
            'cv',
          ),
        ),
      ).toMatchObject({ reason: 'dangerous-content' });
    });

    it.each([
      [
        'macros (vbaProject.bin)',
        xlsxParts([{ name: 'xl/vbaProject.bin', data: Buffer.from('macro') }]),
      ],
      [
        'a macro-enabled content type (.xlsm renamed)',
        xlsxParts(
          [],
          '<Types><Default ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
        ),
      ],
      [
        'an embedded object',
        xlsxParts([
          { name: 'xl/embeddings/oleObject1.bin', data: Buffer.from('ole') },
        ]),
      ],
      [
        'an entry that unzips to more than it declares (bomb)',
        xlsxParts([
          {
            name: 'xl/sharedStrings.xml',
            data: Buffer.alloc(4096, 65),
            declaredSize: 10,
          },
        ]),
      ],
      [
        'an entry declaring a 2 GB size',
        xlsxParts([
          {
            name: 'xl/sharedStrings.xml',
            data: Buffer.from('x'),
            declaredSize: 2_000_000_000,
          },
        ]),
      ],
    ])('an .xlsx with %s', async (_name, archive) => {
      expect(
        await reasonOf(
          validateUpload(
            multerFile(
              archive,
              'ippis.xlsx',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ),
            SPREADSHEET,
            'f',
          ),
        ),
      ).toMatchObject({ status: 422 });
    });

    it('an animated (multi-frame) image', async () => {
      const frames = await sharp({
        create: {
          width: 8,
          height: 16,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();
      const animated = await sharp(frames, { pages: -1 }).png().toBuffer();
      // sharp can't write APNG; if this build produced a single page, the case doesn't apply.
      if (((await sharp(animated, { pages: -1 }).metadata()).pages ?? 1) > 1) {
        expect(
          await reasonOf(
            validateUpload(
              multerFile(animated, 'a.png', 'image/png'),
              PHOTO,
              'f',
            ),
          ),
        ).toMatchObject({ status: 422 });
      }
    });
  });
});

describe('ValidateUpload pipe', () => {
  it('passes a missing file through, so the controller can say it is required', async () => {
    await expect(
      new ValidateUpload(PHOTO).transform(undefined),
    ).resolves.toBeUndefined();
  });

  it('records the field and policy on a rejection', async () => {
    await expect(
      new ValidateUpload(PHOTO, 'selfie').transform(
        multerFile(pdf(), 'x.jpg', 'image/jpeg'),
      ),
    ).rejects.toMatchObject({
      details: {
        field: 'selfie',
        policy: 'photo',
        claimedType: 'image/jpeg',
        detectedType: 'pdf',
        reason: 'type-mismatch',
      },
    });
  });
});

describe('ValidateUploads pipe', () => {
  const pipe = new ValidateUploads({ cv: CV, passportPhoto: PHOTO });

  it('checks each field against its own policy', async () => {
    const result = await pipe.transform({
      cv: [multerFile(pdf(), 'cv.pdf', 'application/pdf')],
      passportPhoto: [multerFile(await jpeg(), 'p.jpg', 'image/jpeg')],
    });
    expect(result.cv[0].detectedType).toBe('pdf');
    expect(result.passportPhoto[0].detectedType).toBe('jpeg');
  });

  it('rejects the whole request when one field is wrong', async () => {
    await expect(
      pipe.transform({
        cv: [multerFile(await jpeg(), 'cv.pdf', 'application/pdf')],
        passportPhoto: [multerFile(await jpeg(), 'p.jpg', 'image/jpeg')],
      }),
    ).rejects.toBeInstanceOf(UploadRejectedException);
  });

  it('rejects a field with no policy', async () => {
    await expect(
      pipe.transform({
        other: [multerFile(pdf(), 'x.pdf', 'application/pdf')],
      }),
    ).rejects.toMatchObject({ details: { field: 'other' } });
  });
});
