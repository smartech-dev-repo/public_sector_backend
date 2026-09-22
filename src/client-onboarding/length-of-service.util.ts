export interface LengthOfService {
  years: number;
  months: number;
}

export function computeLengthOfService(hireDate: Date | null): LengthOfService | null {
  if (!hireDate) {
    return null;
  }
  const now = new Date();
  let months = (now.getFullYear() - hireDate.getFullYear()) * 12 + (now.getMonth() - hireDate.getMonth());
  if (now.getDate() < hireDate.getDate()) {
    months -= 1;
  }
  return { years: Math.floor(months / 12), months: months % 12 };
}
