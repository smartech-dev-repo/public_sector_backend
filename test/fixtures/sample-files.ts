// test/fixtures/sample-files.ts

// A genuinely valid, tiny (~287 byte) JPEG — verified via `file` to report
// "JPEG image data, JFIF standard 1.01" — not a placeholder. Used anywhere
// an e2e test previously attached fake text bytes under a .jpg/.jpeg/.png
// filename.
export const SAMPLE_JPEG_BUFFER = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);

// A genuinely valid, minimal (one blank 200x200pt page) PDF — verified via
// `pdfinfo` to report "PDF version: 1.4, Pages: 1" with correct xref byte
// offsets (not relying on reader leniency). Used anywhere an e2e test
// previously attached fake text bytes under a .pdf filename (CVs, identity
// documents).
export const SAMPLE_PDF_BUFFER = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n203\n%%EOF',
  'utf-8',
);
