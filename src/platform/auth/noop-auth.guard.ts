import { Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isPublicRoute } from './public.decorator.ts';

/**
 * Autenticação fora do foco desta entrega (enunciado §2, I-41): guard global que sempre permite. O ponto de
 * extensão é a porta PROVIDER_IDENTITY; o desenho com IdP externo (Keycloak) está no ARCHITECTURE.md da raiz.
 *
 * Feature 003 (R-41): o guard já lê o metadado de `@Public()`. Rotas públicas (health, métricas, reconciliação) passam
 * sem consultar identidade; quando houver autenticação real, só as demais serão verificadas.
 */
export class NoopAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.isPublic(context)) return true;
    // Ponto de extensão: aqui entraria a verificação do token pelo IdP (PROVIDER_IDENTITY). Hoje, no-op.
    return true;
  }

  isPublic(context: ExecutionContext): boolean {
    return isPublicRoute(this.reflector, context);
  }
}
