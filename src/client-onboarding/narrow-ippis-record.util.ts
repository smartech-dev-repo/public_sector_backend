export interface NarrowableIppisRecord {
  agency: string;
  staffId: string;
  employeeName: string;
  employeeStatus: string | null;
  hireDate: Date | null;
  department: string | null;
  grade: string | null;
  bankName: string | null;
  accountNumber: string | null;
}

// Strips sensitive IppisRecord fields (bvn, salary, pinNumber, rawFields, ...)
// before a record ever leaves the admin/agent client-list or detail response.
export function narrowIppisRecord(ippisRecord: NarrowableIppisRecord | null | undefined) {
  if (!ippisRecord) return undefined;
  return {
    agency: ippisRecord.agency,
    staffId: ippisRecord.staffId,
    employeeName: ippisRecord.employeeName,
    employeeStatus: ippisRecord.employeeStatus,
    hireDate: ippisRecord.hireDate,
    department: ippisRecord.department,
    grade: ippisRecord.grade,
    bankName: ippisRecord.bankName,
    accountNumber: ippisRecord.accountNumber,
  };
}
