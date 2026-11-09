/** Porta de aleatoriedade para o jitter (research R-25; constitution VI): nada de Math.random no domínio. */
export const RANDOM_SOURCE = Symbol('RANDOM_SOURCE');

export interface RandomSource {
  /** Número em [0, 1). */
  next(): number;
}
