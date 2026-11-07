/** Porta do relógio: domínio e use cases nunca chamam new Date() nem Date.now() (constitution VI). */
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}
