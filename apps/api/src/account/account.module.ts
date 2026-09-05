import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountController } from './account.controller';
import { AccountResetService } from './account-reset.service';

// =============================================================================
// AccountModule — self-service account data reset (issue #270)
// =============================================================================
//
// The "Danger zone" surface: one controller, one service, no HTTP surface
// exported for anything else to reach. Four imports, each for exactly one
// dependency `AccountResetService` needs and nothing it does not:
//
//   - `PrismaModule` — the fourteen `ACCOUNT_RESET_TABLES` deletes and the
//     audit write. Imported explicitly even though `PrismaModule` is
//     `@Global()`, matching `JourneyModule`'s and `AiModule`'s own
//     convention: a module that reaches the database says so in its own
//     imports rather than relying on a global registered elsewhere.
//   - `AiModule` — `AiUserKeyService`, for the `data_and_key` scope's key
//     purge. Exported from `AiModule` specifically for this call site (see
//     that module's own `exports` comment).
//   - `StorageModule` — `ObjectsService`, reused so a caller's uploaded
//     files and their provider blobs are actually deleted, not merely
//     orphaned by a raw `deleteMany` over `storage_objects`.
//   - `NotificationsModule` — `NotificationsService`, for the mandatory
//     `account.data_reset` email.
//
// `ConfigModule` is imported explicitly too, for the same reason `AiModule`
// imports it despite the root `ConfigModule` being global: `AccountResetService
// .appUrl` reads configuration, and that dependency is stated here rather
// than assumed.
// =============================================================================

@Module({
  imports: [PrismaModule, AiModule, StorageModule, NotificationsModule, ConfigModule],
  controllers: [AccountController],
  providers: [AccountResetService],
  // Nothing exported: no other module has a reason to reset an account on a
  // caller's behalf, and this feature has no HTTP surface beyond its own
  // controller. The same "narrow, self-contained module" posture
  // `JourneyModule`'s sibling feature modules already take when they have no
  // downstream consumer of their own.
})
export class AccountModule {}
