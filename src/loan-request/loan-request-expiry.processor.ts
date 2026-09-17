import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { LoanRequestExpiryJobData, LoanRequestService } from './loan-request.service';

@Processor(LOAN_REQUEST_EXPIRY_QUEUE)
export class LoanRequestExpiryProcessor extends WorkerHost {
  constructor(private readonly loanRequestService: LoanRequestService) {
    super();
  }

  async process(job: Job<LoanRequestExpiryJobData>): Promise<void> {
    await this.loanRequestService.expire(job.data.loanRequestId);
  }
}
