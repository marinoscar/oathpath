import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';

import { Clock } from './clock';
import { TestClockMiddleware } from './test-clock.middleware';

/**
 * Provides the application's `Clock`.
 *
 * `@Global()` because the clock is infrastructure rather than a feature
 * dependency: the journey module needs it now, and the mastery scheduler,
 * the readiness engine and the streak math will need it in later epics.
 * Making every one of those modules import `ClockModule` would add an import
 * line per module and tell a reader nothing they could not already see from
 * the constructor -- and a missing import would fail at boot rather than at
 * review.
 */
@Global()
@Module({
  providers: [Clock],
  exports: [Clock],
})
export class ClockModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The `X-Test-Clock` override is a non-production test affordance. In
    // production the middleware is never registered, so the header is not
    // read at all -- the code path is absent rather than present-and-ignored.
    // Same shape as `AppModule`'s conditional `TestAuthModule` registration.
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    consumer.apply(TestClockMiddleware).forRoutes('*');
  }
}
