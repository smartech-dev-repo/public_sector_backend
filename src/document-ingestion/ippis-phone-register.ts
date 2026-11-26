import * as ExcelJS from 'exceljs';
import { validNigerianPhone } from '../common/normalize-nigerian-phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeSectorCode } from '../sectors/sector-code.util';
import { buildRowByHeader } from './parsers/build-row-by-header';
import { isRowMappingFailure, mapIppisRow } from './parsers/ippis-row-mapper';

export const PHONE_ALREADY_USED = 'Telephone number already belongs to another staff member or client, so this row will not be merged';

interface StoredRecord {
  agency: string;
  staffId: string;
  phone: string | null;
}

export const ippisKey = (agency: string, staffId: string) => `${agency}::${staffId}`;

/**
 * Keeps one phone number to one IPPIS record across an upload. The first row in the
 * file to use a number gets it. Numbers held in the database count too, unless the
 * staff member who holds them is in this file and so may be changing their number.
 */
export class IppisPhoneRegister {
  private readonly storedPhones = new Map<string, string>();
  private readonly heldElsewhere = new Map<string, Set<string>>();
  private readonly claimedInFile = new Map<string, string>();

  constructor(stored: StoredRecord[], registered: { phone: string; key: string }[], keysInFile: Set<string>) {
    for (const record of stored) {
      const phone = record.phone && validNigerianPhone(record.phone);
      if (!phone) continue;
      const key = ippisKey(record.agency, record.staffId);
      this.storedPhones.set(key, phone);
      if (!keysInFile.has(key)) this.hold(phone, key);
    }
    // A registered client keeps their number even when a later broadsheet changes their record.
    for (const { phone, key } of registered) {
      this.hold(phone, key);
    }
  }

  private hold(phone: string, key: string) {
    const holders = this.heldElsewhere.get(phone) ?? new Set<string>();
    this.heldElsewhere.set(phone, holders.add(key));
  }

  /** False when the number belongs to someone else. An unreadable number has no owner. */
  claim(key: string, rawPhone: string | null): boolean {
    const phone = rawPhone && validNigerianPhone(rawPhone);
    if (!phone) return true;

    const claimant = this.claimedInFile.get(phone);
    if (claimant && claimant !== key) return false;

    // An unchanged number stays, so an old duplicate can't freeze this staff member's updates.
    const unchanged = this.storedPhones.get(key) === phone;
    const heldByOther = [...(this.heldElsewhere.get(phone) ?? [])].some((holder) => holder !== key);
    if (heldByOther && !unchanged) return false;

    this.claimedInFile.set(phone, key);
    return true;
  }
}

function staffKeysInFile(workbook: ExcelJS.Workbook, sectors: string[]): Set<string> {
  const keys = new Set<string>();
  for (const worksheet of workbook.worksheets) {
    const agency = normalizeSectorCode(worksheet.name);
    if (!sectors.includes(agency)) continue;
    const headerValues = worksheet.getRow(1).values as unknown[];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      const mapped = mapIppisRow(buildRowByHeader(headerValues, row.values as unknown[]));
      if (!isRowMappingFailure(mapped)) keys.add(ippisKey(agency, mapped.record.staffId));
    }
  }
  return keys;
}

export async function buildIppisPhoneRegister(
  prisma: PrismaService,
  stored: StoredRecord[],
  workbook: ExcelJS.Workbook,
  sectors: string[],
): Promise<IppisPhoneRegister> {
  const onboarded = await prisma.clientOnboarding.findMany({
    select: { client: { select: { phone: true } }, ippisRecord: { select: { agency: true, staffId: true } } },
  });
  const registered = onboarded.map(({ client, ippisRecord }) => ({
    phone: client.phone,
    key: ippisKey(ippisRecord.agency, ippisRecord.staffId),
  }));
  return new IppisPhoneRegister(stored, registered, staffKeysInFile(workbook, sectors));
}
