// The starting sectors, used for template defaults. The live list is the Sector table.
export const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOMS', 'LASG'] as const;
export type KnownAgency = (typeof KNOWN_AGENCIES)[number];
