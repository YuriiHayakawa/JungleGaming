import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { setRequestContextValues } from '../../../platform/correlation/request-context.ts';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe.ts';
import type { CreateWalletUseCase, WalletView } from '../../application/create-wallet.use-case.ts';
import type { GetWalletUseCase } from '../../application/get-wallet.use-case.ts';
import { parseLimit } from '../../application/ledger-cursor.ts';
import type { LedgerPageView, ListLedgerUseCase } from '../../application/list-ledger.use-case.ts';
import { createWalletSchema, ledgerQuerySchema, walletIdParamSchema, type CreateWalletRequest } from './wallet.dto.ts';

export const CREATE_WALLET_USE_CASE = Symbol('CREATE_WALLET_USE_CASE');
export const GET_WALLET_USE_CASE = Symbol('GET_WALLET_USE_CASE');
export const LIST_LEDGER_USE_CASE = Symbol('LIST_LEDGER_USE_CASE');

const walletIdPipe = new ZodValidationPipe(walletIdParamSchema);
const ledgerQueryPipe = new ZodValidationPipe(ledgerQuerySchema);

/** Controller fino: valida com Zod explícito e delega ao use case (research R-02, R-13). */
@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET_USE_CASE) private readonly createWallet: CreateWalletUseCase,
    @Inject(GET_WALLET_USE_CASE) private readonly getWallet: GetWalletUseCase,
    @Inject(LIST_LEDGER_USE_CASE) private readonly listLedger: ListLedgerUseCase,
  ) {}

  /** 201 { id, playerId, balance, version }. O walletId entra no contexto de log no use case (constitution VIII). */
  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletRequest): Promise<WalletView> {
    return this.createWallet.execute(body);
  }

  /** GET /wallets/:walletId → 200 { id, playerId, balance, version } (FR-049); 404 WALLET_NOT_FOUND. */
  @Get(':walletId')
  get(@Param() params: unknown): Promise<WalletView> {
    const { walletId } = walletIdPipe.transform(params);
    setRequestContextValues({ walletId });
    return this.getWallet.execute(walletId);
  }

  /** GET /wallets/:walletId/ledger?cursor=&limit= → 200 LedgerPage (FR-050, FR-051, I-36, I-47). */
  @Get(':walletId/ledger')
  ledger(@Param() params: unknown, @Query() query: unknown): Promise<LedgerPageView> {
    const { walletId } = walletIdPipe.transform(params);
    setRequestContextValues({ walletId });
    const { cursor, limit } = ledgerQueryPipe.transform(query);
    return this.listLedger.execute({ walletId, cursor, limit: parseLimit(limit) });
  }
}
