-- Rewrites IPPIS phones to the app's +234 format, e.g. 8031234567, 08031234567,
-- 234 803 123 4567 and +23408031234567 all become +2348031234567.
-- Only a number that reads as exactly one Nigerian mobile changes. Anything else,
-- such as a short number or two numbers in one cell, stays as uploaded so nothing
-- is guessed. Safe to run twice. The log gives counts only, never the numbers.
DO $$
DECLARE
  updated_count INTEGER;
  unfixable_count INTEGER;
  shared_count INTEGER;
BEGIN
  WITH parsed AS (
    SELECT id, phone, (regexp_match(regexp_replace(phone, '\D', '', 'g'), '^(?:00)?(?:234)?0?([789][01]\d{8})$'))[1] AS local_number
    FROM "IppisRecord"
    WHERE phone IS NOT NULL
  )
  UPDATE "IppisRecord" AS record
  SET phone = '+234' || parsed.local_number, "updatedAt" = CURRENT_TIMESTAMP
  FROM parsed
  WHERE record.id = parsed.id
    AND parsed.local_number IS NOT NULL
    AND record.phone <> '+234' || parsed.local_number;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  SELECT COUNT(*) INTO unfixable_count
  FROM "IppisRecord"
  WHERE phone IS NOT NULL AND btrim(phone) <> '' AND phone !~ '^\+234[789][01]\d{8}$';

  -- Uploads now refuse a number another staff record holds. Existing duplicates are only
  -- counted here: someone has to decide which staff member each number belongs to.
  SELECT COUNT(*) INTO shared_count
  FROM (SELECT phone FROM "IppisRecord" WHERE phone ~ '^\+234' GROUP BY phone HAVING COUNT(*) > 1) AS shared;

  RAISE NOTICE 'IPPIS phones: % updated, % could not be fixed and were left as uploaded, % numbers are held by more than one record', updated_count, unfixable_count, shared_count;
END $$;
