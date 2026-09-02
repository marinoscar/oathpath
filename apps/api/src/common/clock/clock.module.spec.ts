import { Injectable, MiddlewareConsumer, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Clock } from './clock';
import { ClockModule } from './clock.module';
import { TestClockMiddleware } from './test-clock.middleware';

/** A stand-in for Nest's `MiddlewareConsumer` that records what was applied. */
const recordingConsumer = () => {
  const forRoutes = jest.fn();
  const exclude = jest.fn(() => ({ forRoutes }));
  const apply = jest.fn(() => ({ forRoutes, exclude }));

  return {
    consumer: { apply } as unknown as MiddlewareConsumer,
    apply,
    forRoutes,
  };
};

describe('ClockModule', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('configure()', () => {
    it.each(['development', 'test', 'staging', undefined])(
      'registers TestClockMiddleware for all routes when NODE_ENV is %s',
      (nodeEnv) => {
        if (nodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = nodeEnv;
        }

        const { consumer, apply, forRoutes } = recordingConsumer();
        new ClockModule().configure(consumer);

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(TestClockMiddleware);
        expect(forRoutes).toHaveBeenCalledWith('*');
      },
    );

    it('registers no middleware at all when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';

      const { consumer, apply, forRoutes } = recordingConsumer();
      new ClockModule().configure(consumer);

      // The structural claim, not merely "some downstream value was
      // unchanged": in production the X-Test-Clock code path is absent, so the
      // header is never read. Nothing to bypass, nothing to misconfigure.
      expect(apply).not.toHaveBeenCalled();
      expect(forRoutes).not.toHaveBeenCalled();
    });

    it('reads NODE_ENV at configure() time, not at module load time', () => {
      // Guards against someone hoisting the check to a module-level constant,
      // which would make the production gate depend on import order.
      process.env.NODE_ENV = 'production';
      const production = recordingConsumer();
      new ClockModule().configure(production.consumer);
      expect(production.apply).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'development';
      const development = recordingConsumer();
      new ClockModule().configure(development.consumer);
      expect(development.apply).toHaveBeenCalledWith(TestClockMiddleware);
    });
  });

  describe('provider graph', () => {
    it('provides Clock as a singleton', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ClockModule],
      }).compile();

      const clock = moduleRef.get(Clock);
      expect(clock).toBeInstanceOf(Clock);
      expect(moduleRef.get(Clock)).toBe(clock);

      await moduleRef.close();
    });

    it('is global, so a module that never imports it can still inject Clock', async () => {
      @Injectable()
      class LaterEpicService {
        constructor(readonly clock: Clock) {}
      }

      @Module({ providers: [LaterEpicService], exports: [LaterEpicService] })
      class LaterEpicModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [ClockModule, LaterEpicModule],
      }).compile();

      expect(moduleRef.get(LaterEpicService).clock).toBeInstanceOf(Clock);

      await moduleRef.close();
    });
  });
});
