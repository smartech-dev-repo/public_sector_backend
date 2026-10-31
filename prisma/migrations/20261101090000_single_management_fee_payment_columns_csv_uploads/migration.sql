-- Rename the month payment columns; the names now say which month they hold.
ALTER TABLE "IppisRecord" RENAME COLUMN "monthAPayment" TO "paymentThreeMonthsAgo";
ALTER TABLE "IppisRecord" RENAME COLUMN "monthBPayment" TO "paymentTwoMonthsAgo";
ALTER TABLE "IppisRecord" RENAME COLUMN "monthCPayment" TO "paymentLastMonth";

-- CSV uploads record the agency a sheet name would otherwise give.
ALTER TABLE "DocumentUploadBatch" ADD COLUMN "sheetName" TEXT;

-- A loan product now has one management fee.
ALTER TABLE "LoanProduct" ADD COLUMN "managementFeeId" TEXT;

-- Keep an existing link, taking the fee that matches the charge the product shows.
UPDATE "LoanProduct" p
SET "managementFeeId" = (
  SELECT l."B"
  FROM "_LoanProductToManagementFee" l
  JOIN "ManagementFee" f ON f."id" = l."B"
  WHERE l."A" = p."id"
  ORDER BY (f."type" = p."managementChargeType" AND f."value" = p."managementChargeValue") DESC, f."createdAt"
  LIMIT 1
);

ALTER TABLE "LoanProduct" ADD CONSTRAINT "LoanProduct_managementFeeId_fkey" FOREIGN KEY ("managementFeeId") REFERENCES "ManagementFee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "_LoanProductToManagementFee";
