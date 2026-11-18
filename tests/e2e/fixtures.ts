/** Small files built at test time for the error cases. */

function buildPdf(objects: string[], trailerExtra = ''): Buffer {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A one-page PDF locked with a user password (standard security handler). */
export function lockedPdf(): Buffer {
  const id = '<0123456789ABCDEF0123456789ABCDEF>';
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      `<< /Filter /Standard /V 1 /R 2 /O <${'4A'.repeat(32)}> /U <${'7B'.repeat(32)}> /P -44 >>`,
    ],
    `/Encrypt 4 0 R /ID [${id} ${id}] `,
  );
}

/** Starts like a PDF but the rest is noise (a broken download). */
export function brokenPdf(): Buffer {
  const noise = Buffer.alloc(4000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + 13) % 251;
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), noise]);
}

/** The start of an old binary Word (.doc) file. */
export function legacyDoc(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2048)]);
}

/** A PDF-looking file over the 20 MB limit. */
export function hugePdf(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(21 * 1024 * 1024, 32)]);
}
