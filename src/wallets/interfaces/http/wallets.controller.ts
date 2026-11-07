import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe.ts';
import type { CreateWalletUseCase, WalletView } from '../../application/create-wallet.use-case.ts';
import { createWalletSchema, type CreateWalletRequest } from './wallet.dto.ts';

export const CREATE_WALLET_USE_CASE = Symbol('CREATE_WALLET_USE_CASE');

/** Controller fino: valida com Zod explícito e delega ao use case (research R-02, R-13). */
@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CREATE_WALLET_USE_CASE) private readonly createWallet: CreateWalletUseCase) {}

  /** 201 { id, playerId, balance, version }. O walletId entra no contexto de log no use case (constitution VIII). */
  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletRequest): Promise<WalletView> {
    return this.createWallet.execute(body);
  }
}
