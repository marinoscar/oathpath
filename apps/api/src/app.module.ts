import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { ClockModule } from './common/clock/clock.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { HealthModule } from './health/health.module';
import { AllowlistModule } from './allowlist/allowlist.module';
import { JourneyModule } from './journey/journey.module';
import { CivicsModule } from './civics/civics.module';
import { DeviceAuthModule } from './device-auth/device-auth.module';
import { StorageModule } from './storage/storage.module';
import { PatModule } from './pat/pat.module';
import { CredentialsModule } from './credentials/credentials.module';
import { EmailModule } from './email/email.module';
import { AiModule } from './ai/ai.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LoggerModule } from './common/logger/logger.module';
import { TestAuthModule } from './test-auth/test-auth.module';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

import configuration from './config/configuration';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Scheduling (must be at root level for NestJS 11)
    ScheduleModule.forRoot(),

    // Event emitter for async events
    EventEmitterModule.forRoot(),

    // Database
    PrismaModule,

    // Logger
    LoggerModule,

    // Feature modules
    CommonModule,
    // The application's single notion of "now" (#63, epic #50). @Global, so
    // later consumers inject `Clock` without importing this module; it also
    // registers the non-production-only `X-Test-Clock` middleware from its
    // own `configure()`.
    ClockModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    HealthModule,
    AllowlistModule,
    // The journey shell's API (#65, epic #50): the learner profile, the
    // orientation write, Home's deterministic next action, and the stage
    // registry the web reads rather than duplicating. Every route is
    // `@Auth()` with no permissions and resolves the learner from
    // `@CurrentUser('id')` — no new permission string, and no route that
    // accepts a user id.
    JourneyModule,
    // The civics question bank's read API (#111, epic #51): versions,
    // categories, a paginated question list, and one question with its
    // answers resolved against the caller's own state. Every route is
    // `@Auth()` with no permissions — the same reasoning JourneyModule
    // records — and no route accepts a user id or a state code.
    CivicsModule,
    DeviceAuthModule,
    StorageModule,
    PatModule,
    // Encrypted credential store (#115). Registered here so it is part of the
    // module graph; consumers still import CredentialsModule explicitly (it is
    // not @Global) so every user of a plaintext-returning service is visible.
    CredentialsModule,
    // Email transports (#122, epic #109) and, since #124, the admin email
    // settings endpoints. Registered here even though nothing sends mail
    // automatically yet: it makes a broken provider graph fail at boot rather
    // than surfacing as a DI error in #125. It costs nothing at runtime --
    // neither transport touches the network or reads a credential until its
    // first send.
    EmailModule,

    // AI configuration: the server key, the model-role bindings, and the
    // per-user BYOK surface (epic #25). Like EmailModule, it owns its own
    // `system_settings` row and its own credential purposes.
    AiModule,
    // Notifications (#121/#124/#125, epic #109): the event registry endpoint,
    // and since #125 the dispatcher, preference resolution and delivery
    // records. Registered here even though no real event is wired yet (#128)
    // so a broken channel graph — a duplicate channel registration, a missing
    // transport — fails at boot rather than at the first notification.
    NotificationsModule,

    // Test modules (non-production only)
    ...(process.env.NODE_ENV !== 'production' ? [TestAuthModule] : []),
  ],
  providers: [
    // Global validation pipe (Zod)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global response transform interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes('*');
  }
}
