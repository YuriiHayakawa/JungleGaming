import { DomainError } from '../../shared-kernel/domain/errors.ts';

export interface PendingReferencePolicyConfig {
  /** Tentativas totais antes do REFERENCE_NOT_FOUND (I-64; padrão 10). */
  maxAttempts: number;
  /** Teto de segurança contado de created_at (I-64; padrão 600000). */
  ttlMs: number;
  /** Base do backoff exponencial (I-21; padrão 5000). */
  baseMs: number;
  /** Teto da espera (I-21; padrão 60000). */
  maxMs: number;
  /** Jitter multiplicativo uniforme em [1 − r, 1 + r] (R-25; padrão 0,2; de 0 a 0,5). */
  jitterRatio: number;
}

export class InvalidPendingReferencePolicyError extends DomainError {}

/**
 * Política de reavaliação de PENDING_REFERENCE (I-21, I-64, I-72; research R-25). Serviço de domínio puro: o número
 * aleatório do jitter vem de fora (porta RandomSource), o tempo também (porta Clock).
 *
 * - Espera antes da tentativa k (k ≥ 2): min(base × 2^(k−1), teto) × (1 − r + 2r × random). A 1ª tentativa já foi
 *   agendada pela 001 em created_at + base, sem jitter. Sem jitter: 5, 10, 20, 40, 60 … 60 s; a 10ª tentativa acontece
 *   435 s depois da criação.
 * - Esgotou: tentativas depois desta avaliação ≥ maxAttempts, ou now − createdAt ≥ ttlMs. Só conta como tentativa a
 *   avaliação concluída com a referência ausente ou pendente; o esgotamento só é consultado depois de a referência ser
 *   relida (I-72).
 */
export class PendingReferencePolicy {
  constructor(private readonly config: PendingReferencePolicyConfig) {
    const { maxAttempts, ttlMs, baseMs, maxMs, jitterRatio } = config;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidPendingReferencePolicyError('maxAttempts must be a positive integer');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new InvalidPendingReferencePolicyError('ttlMs must be a positive integer');
    if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maxMs) || baseMs > maxMs) {
      throw new InvalidPendingReferencePolicyError('baseMs and maxMs must be positive integers with baseMs <= maxMs');
    }
    if (!(jitterRatio >= 0 && jitterRatio <= 0.5)) {
      throw new InvalidPendingReferencePolicyError('jitterRatio must be between 0 and 0.5');
    }
  }

  /** Espera, em ms, antes da tentativa `attemptNumber` (≥ 2), com `random` em [0, 1). */
  delayBefore(attemptNumber: number, random: number): number {
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 2) {
      throw new InvalidPendingReferencePolicyError('attemptNumber must be an integer >= 2');
    }
    if (!(random >= 0 && random < 1)) throw new InvalidPendingReferencePolicyError('random must be in [0, 1)');
    const { baseMs, maxMs, jitterRatio } = this.config;
    const nominal = Math.min(baseMs * 2 ** (attemptNumber - 1), maxMs);
    return Math.round(nominal * (1 - jitterRatio + 2 * jitterRatio * random));
  }

  /** `attemptsAfterThis` conta a avaliação atual (I-64). */
  isExhausted(attemptsAfterThis: number, createdAt: Date, now: Date): boolean {
    return attemptsAfterThis >= this.config.maxAttempts || now.getTime() - createdAt.getTime() >= this.config.ttlMs;
  }
}
