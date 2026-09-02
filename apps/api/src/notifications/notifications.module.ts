import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BrowserNotificationChannel } from './channels/browser-notification.channel';
import { EmailNotificationChannel } from './channels/email-notification.channel';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationStoreService } from './notification-store.service';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type NotificationChannelSender,
} from './notification.types';

// =============================================================================
// NotificationsModule (issues #121/#124/#125, epic #109)
// =============================================================================
//
// #121 shipped the registry as pure data with no module. #124 added the one
// endpoint that serves it. #125 added what the epic was actually for: the
// dispatcher, the channel abstraction, and the delivery records. #127 adds the
// browser channel and everything under it — the durable `notifications` store,
// the SSE transport, and the notification centre's endpoints.
//
// -----------------------------------------------------------------------------
// THE CHANNEL LIST IS A FACTORY, AND THAT IS THE EXTENSION POINT
// -----------------------------------------------------------------------------
//
// `NotificationsService` does not inject `EmailNotificationChannel`. It
// injects an ARRAY under `NOTIFICATION_CHANNEL_SENDERS` and iterates whatever
// is in it. So adding #127's browser channel is:
//
//   1. a class implementing `NotificationChannelSender`
//   2. its name in the `inject` list and its parameter in the factory below
//
// and NOTHING in the dispatcher changes. Had the dispatcher taken each channel
// as a constructor parameter, step 2 would have been an edit to the dispatcher
// — and then to its every test's construction — which is the "adding a channel
// is a rewrite" outcome #125 asks to avoid.
//
// THE FACTORY IS EXPLICIT, NOT DISCOVERED. Nest can enumerate providers by
// metadata (`DiscoveryService`), and that would let a channel register itself
// merely by existing. Rejected: "which transports can this app deliver over?"
// would then have no answer readable in a file, and a channel added by an
// import side effect is a channel that appears in production without appearing
// in a diff. This list is short, it is reviewed, and it is the point.
//
// #125 SHIPPED NO BROWSER STUB, and #127 is the payoff: registering
// `BrowserNotificationChannel` below is the entire wiring change. Nothing in
// `NotificationsService` was touched to add a second transport, which is what
// the array-under-a-token indirection above was for.
//
// -----------------------------------------------------------------------------
// WHY `NotificationStreamService` IS A PROVIDER AND NOT EXPORTED (#127)
// -----------------------------------------------------------------------------
//
// It is shared state — a process-wide map of open connections — so it must be
// a singleton, which is what a module provider gives. It is NOT exported,
// because a feature able to call `publish` directly could push an arbitrary
// payload to a user's open tabs while writing no `notifications` row and no
// `notification_deliveries` row: a notification with no durable record, no
// preference check, and no `mandatory` gate. The ONLY caller is
// `BrowserNotificationChannel`, which is reached through the dispatcher, which
// is where the gate lives. Same reasoning as #125's refusal to export
// `NotificationDeliveryService`.
//
// `NotificationStoreService` is likewise internal: it is the controller's
// backing store for the caller's OWN rows, and every method takes a user id it
// filters on. Exporting it would put a "read any user's notifications" API one
// import away from any module that wanted one.
// =============================================================================

@Module({
  imports: [
    // The dispatcher reads `users` (for the recipient address) and
    // `user_settings` (for preferences), and the delivery service writes
    // `notification_deliveries`.
    PrismaModule,
    // Transports and email configuration for the one implemented channel.
    // Imported explicitly because EmailModule is deliberately not @Global —
    // it can reach a plaintext-returning credential service, so every consumer
    // shows up in a diff.
    EmailModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    NotificationStoreService,
    NotificationStreamService,
    EmailNotificationChannel,
    BrowserNotificationChannel,
    {
      provide: NOTIFICATION_CHANNEL_SENDERS,
      useFactory: (
        email: EmailNotificationChannel,
        browser: BrowserNotificationChannel,
      ): NotificationChannelSender[] => [email, browser],
      inject: [EmailNotificationChannel, BrowserNotificationChannel],
    },
  ],
  // ONLY the dispatcher is exported. `NotificationDeliveryService`, the store,
  // the stream and the channels are internals: a feature that wants to notify
  // someone calls `notify`, and must not be able to write a delivery record for
  // a send that did not happen, push to a user's open tabs without a durable
  // row, or reach past the preference gate by invoking a channel directly. That
  // gate is only a gate if there is no way around it.
  exports: [NotificationsService],
})
export class NotificationsModule {}
