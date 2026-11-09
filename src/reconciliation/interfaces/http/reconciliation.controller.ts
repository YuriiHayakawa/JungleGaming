import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Public } from '../../../platform/auth/public.decorator.ts';
import { setRequestContextValues } from '../../../platform/correlation/request-context.ts';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe.ts';
import { walletIdParamSchema } from '../../../wallets/interfaces/http/wallet.dto.ts';
import type { ReconcileWalletUseCase, ReconciliationView } from '../../application/reconcile-wallet.use-case.ts';

export const RECONCILE_WALLET_USE_CASE = Symbol('RECONCILE_WALLET_USE_CASE');

const walletIdPipe = new ZodValidationPipe(walletIdParamSchema);

/**
 * `POST /wallets/:walletId/reconciliation` (FR-001 a FR-012; contracts/http.md). Sem corpo: um corpo enviado é
 * ignorado (não há `@Body`). Sem autenticação (`@Public()`, FR-018/SC-009). 200 consistente ou não; 400, 404 e 503 no
 * envelope único (I-38), pelo filtro global.
 */
@Controller('wallets')
export class ReconciliationController {
  constructor(@Inject(RECONCILE_WALLET_USE_CASE) private readonly reconcileWallet: ReconcileWalletUseCase) {}

  @Public()
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param() params: unknown): Promise<ReconciliationView> {
    const { walletId } = walletIdPipe.transform(params);
    setRequestContextValues({ walletId });
    return this.reconcileWallet.execute(walletId);
  }
}
