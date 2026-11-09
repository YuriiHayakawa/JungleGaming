import { Controller, Get, Inject, Param } from '@nestjs/common';
import { setRequestContextValues } from '../../../platform/correlation/request-context.ts';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe.ts';
import type { GetTransactionUseCase, TransactionView } from '../../application/get-transaction.use-case.ts';
import { providerTransactionParamsSchema } from './wager-transaction.dto.ts';
import { GET_TRANSACTION_USE_CASE } from './wagering.controller.ts';

const paramsPipe = new ZodValidationPipe(providerTransactionParamsSchema);

/** GET /providers/:providerId/wagering/transactions/:externalTransactionId (FR-052, FR-053, I-55, I-07). */
@Controller('providers')
export class ProvidersController {
  constructor(@Inject(GET_TRANSACTION_USE_CASE) private readonly getTransaction: GetTransactionUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async get(@Param() params: unknown): Promise<TransactionView> {
    const { providerId, externalTransactionId } = paramsPipe.transform(params);
    setRequestContextValues({ providerId });
    const view = await this.getTransaction.byProviderAndExternalId(providerId, externalTransactionId);
    setRequestContextValues({ walletId: view.walletId, transactionId: view.transactionId });
    return view;
  }
}
