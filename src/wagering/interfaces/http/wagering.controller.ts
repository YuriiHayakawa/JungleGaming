import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import { setRequestContextValues } from '../../../platform/correlation/request-context.ts';
import type { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case.ts';
import { httpStatusFor, type TransactionResult } from '../../application/transaction-result.ts';
import { parseIdempotencyKey, parseSubmitWagerTransactionBody } from './wager-transaction.dto.ts';

export const SUBMIT_WAGER_TRANSACTION_USE_CASE = Symbol('SUBMIT_WAGER_TRANSACTION_USE_CASE');

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * POST /wagering/transactions. Controller fino: o header é validado antes do corpo (I-44 passos 1 e 2, I-48), o corpo
 * pelo pipe Zod explícito, e a resposta de negócio (201, 202, 422) é montada a partir do TransactionResult, sem
 * passar pelo filtro de exceções (I-45).
 */
@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(SUBMIT_WAGER_TRANSACTION_USE_CASE) private readonly submitWager: SubmitWagerTransactionUseCase) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<TransactionResult> {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const input = parseSubmitWagerTransactionBody(body);
    // Contexto de log (constitution VIII): walletId e providerId logo depois da validação; o transactionId é gravado
    // pelo use case quando encontra a transação existente (replay ou conflito) ou depois do commit da nova.
    setRequestContextValues({ walletId: input.walletId, providerId: input.providerId });

    const result = await this.submitWager.execute({ idempotencyKey, input });
    response.status(httpStatusFor(result));
    return result;
  }
}
