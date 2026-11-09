import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

/** Metadado lido pelo guard global (R-41). */
export const IS_PUBLIC_KEY = 'jg:isPublic';

/**
 * Marca uma rota (ou um controller inteiro) como sem autenticação: health, métricas e reconciliação (003, FR-018,
 * FR-019, SC-009). Hoje o guard global é no-op e libera tudo; com autenticação real, continuará liberando estas.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** true se o handler ou a classe do contexto tem `@Public()`. */
export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) === true;
}
