import { buildPaginatedResult } from './paginated-result';

describe('buildPaginatedResult', () => {
  it('builds the envelope with correct totalPages for an exact multiple', () => {
    const result = buildPaginatedResult(['a', 'b'], 50, 1, 25);
    expect(result).toEqual({ data: ['a', 'b'], meta: { total: 50, page: 1, limit: 25, totalPages: 2 } });
  });

  it('rounds totalPages up for a partial last page', () => {
    const result = buildPaginatedResult(['a'], 51, 3, 25);
    expect(result.meta.totalPages).toBe(3);
  });

  it('returns totalPages 0 when total is 0', () => {
    const result = buildPaginatedResult([], 0, 1, 25);
    expect(result.meta.totalPages).toBe(0);
  });
});
