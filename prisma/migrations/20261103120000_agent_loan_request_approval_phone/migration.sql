-- Admin number that agent-assisted clients send their loan code to.
ALTER TABLE "LoanSettings" ADD COLUMN "loanApprovalPhone" TEXT;

-- Which agent, if any, made a loan request for the client.
ALTER TABLE "LoanRequest" ADD COLUMN "requestedByAgentId" TEXT;
CREATE INDEX "LoanRequest_requestedByAgentId_idx" ON "LoanRequest"("requestedByAgentId");
ALTER TABLE "LoanRequest" ADD CONSTRAINT "LoanRequest_requestedByAgentId_fkey"
  FOREIGN KEY ("requestedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
