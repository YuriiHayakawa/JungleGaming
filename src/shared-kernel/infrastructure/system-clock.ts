import type { Clock } from '../domain/clock.port.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
