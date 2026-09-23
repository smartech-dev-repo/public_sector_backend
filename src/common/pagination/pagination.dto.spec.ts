import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginationDto } from './pagination.dto';

describe('PaginationDto', () => {
  it('defaults to page 1, limit 25 when neither is provided', () => {
    const dto = plainToInstance(PaginationDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(25);
  });

  it('coerces query-string numbers and computes skip/take', () => {
    const dto = plainToInstance(PaginationDto, { page: '3', limit: '10' });
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(10);
    expect(dto.getSkipTake()).toEqual({ skip: 20, take: 10 });
  });

  it('computes skip 0 for page 1 regardless of limit', () => {
    const dto = plainToInstance(PaginationDto, { page: '1', limit: '25' });
    expect(dto.getSkipTake()).toEqual({ skip: 0, take: 25 });
  });

  it('rejects limit above 100', async () => {
    const dto = plainToInstance(PaginationDto, { limit: '500' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects page below 1', async () => {
    const dto = plainToInstance(PaginationDto, { page: '0' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'page')).toBe(true);
  });

  it('passes validation with no params at all', async () => {
    const dto = plainToInstance(PaginationDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
