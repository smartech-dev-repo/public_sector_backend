// src/loan-request/eligibility/service-length-eligible.util.ts
export interface ServiceLengthBounds {
  minimumServiceMonthsLeft: number | null;
  maximumMonthsInService: number | null;
}

export function isServiceLengthEligible(
  product: ServiceLengthBounds,
  monthsLeft: number | null,
  monthsServed: number | null,
): boolean {
  return (
    (product.minimumServiceMonthsLeft == null ||
      (monthsLeft != null && monthsLeft >= product.minimumServiceMonthsLeft)) &&
    (product.maximumMonthsInService == null ||
      (monthsServed != null && monthsServed <= product.maximumMonthsInService))
  );
}
