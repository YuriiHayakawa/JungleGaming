import type { CanActivate } from '@nestjs/common';

/**
 * Autenticação fora do foco desta entrega (enunciado §2, I-41): guard global que sempre permite. O ponto de
 * extensão é a porta PROVIDER_IDENTITY; o desenho com IdP externo (Keycloak) está no ARCHITECTURE.md da raiz.
 */
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
