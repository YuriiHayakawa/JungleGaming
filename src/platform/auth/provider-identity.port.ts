/** Porta da identidade do provedor autenticado (I-41). Com IdP, viria do token; aqui não há autenticação. */
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  resolve(request: unknown): Promise<ProviderIdentity | undefined>;
}

/** Implementação no-op: não autentica; a identidade do provedor vem do payload e passa pelas validações de domínio. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
