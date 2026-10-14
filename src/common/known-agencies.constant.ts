export const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'] as const;
export type KnownAgency = (typeof KNOWN_AGENCIES)[number];
