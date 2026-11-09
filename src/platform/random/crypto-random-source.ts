import type { RandomSource } from './random-source.port.ts';

/** Adapter da porta RandomSource com `crypto.getRandomValues`: 32 bits aleatórios divididos por 2^32, em [0, 1). */
export class CryptoRandomSource implements RandomSource {
  next(): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return (buffer[0] ?? 0) / 0x1_0000_0000;
  }
}
