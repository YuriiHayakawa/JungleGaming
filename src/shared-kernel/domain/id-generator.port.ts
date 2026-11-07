/** Porta de geração de ids (UUIDv7, I-35): domínio e use cases nunca geram ids diretamente (constitution VI). */
export const ID_GENERATOR = Symbol('ID_GENERATOR');

export interface IdGenerator {
  next(): string;
}
