// =============================================================================
// Email -- public surface (issue #122, epic #109)
// =============================================================================
//
// #122 shipped the transports and their configuration; #123 added the template
// layer and #124 the admin settings endpoints, each behind the same barrel,
// exactly as that arrangement anticipated -- no call site changed its import
// path to get them. #128 added the three real event templates and their
// payload types behind the same barrel, and again nothing moved.
//
// NOTHING EXPORTED FROM HERE CAN CARRY THE SMTP PASSWORD. The write DTO's
// `smtpPassword` is request-only and is stripped before persistence; the
// response DTO and `EmailSettingsAdminView` both carry compile-time proofs
// that they have no secret-bearing field.
//
// `BaseEmailProvider` is exported for the same reason it exists: a new
// transport extends it and inherits the never-throw guarantee. Implementing
// `EmailProvider` directly is how that guarantee gets lost.
// =============================================================================

export { BaseEmailProvider, SecretRedactor } from './base-email.provider';
export { EmailModule } from './email.module';
export {
  EmailSettingsService,
  EMAIL_SETTINGS_KEY,
} from './email-settings.service';
export { EmailSettingsController } from './email-settings.controller';
export {
  EmailTestSendService,
  formatFromHeader,
} from './email-test-send.service';
export {
  SMTP_CREDENTIAL_LABEL,
} from './smtp-credential.constants';
export { updateEmailSettingsSchema } from './dto/update-email-settings.dto';
export { emailSettingsResponseSchema } from './dto/email-settings-response.dto';
export { testEmailResultSchema } from './dto/test-email-result.dto';
export {
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_SMTP_PORT,
  EMAIL_PROVIDER_KINDS,
  IMPLICIT_TLS_SMTP_PORT,
  emailSettingsSchema,
} from './email-settings.schema';
export { SesEmailProvider } from './providers/ses-email.provider';

// Templates (#123). The registry is the dispatch surface #125 renders through;
// `SafeHtml`/`html` are the escaping mechanism every template is built on --
// see ./templates/safe-html.ts for why escaping is the default path here and
// not a call each template has to remember.
export {
  APP_NAME,
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  escapeHtml,
  findEmailTemplate,
  html,
  isEmailTemplateName,
  plainText,
  renderEmailTemplate,
  renderLayout,
  safeUrl,
  testEmail,
  // The three real event templates (#128).
  userWelcomeEmail,
  allowlistInvitationEmail,
  roleChangedEmail,
  // Epic #56 / E7's three practice reminders.
  practiceDailyReminderEmail,
  practiceReviewDueEmail,
  streakAtRiskEmail,
  // Self-service account data reset (issue #270).
  accountDataResetEmail,
} from './templates';
export {
  SmtpEmailProvider,
  SMTP_CREDENTIAL_NAME,
  SMTP_CREDENTIAL_PURPOSE,
} from './providers/smtp-email.provider';

export type { EmailMessage, EmailSendResult } from './email.types';
export type {
  EmailTemplate,
  EmailTemplateDataMap,
  EmailTemplateName,
  PlainTextOptions,
  RenderLayoutOptions,
  RenderedEmail,
  TestEmailData,
  // Event payload types (#128). A `notify()` call site annotates its payload
  // with one of these; it is the only place the shape is checked, because
  // `notify` takes `data: unknown` by design.
  UserWelcomeEmailData,
  AllowlistInvitationEmailData,
  RoleChangedEmailData,
  // Epic #56 / E7's three reminder payloads, annotated at
  // `PracticeReminderTask`'s own `notify()` call sites for the same reason.
  PracticeDailyReminderEmailData,
  PracticeReviewDueEmailData,
  StreakAtRiskEmailData,
  // `AccountResetService.reset`'s payload, for the same reason (issue #270).
  AccountDataResetEmailData,
} from './templates';
export type { EmailProvider } from './providers/email-provider.interface';
export type {
  EmailProviderKind,
  EmailSettings,
} from './email-settings.schema';
export type {
  EmailSettingsAdminView,
  SmtpPasswordStatus,
} from './email-settings.service';
export type { TestSendActor } from './email-test-send.service';
export type { UpdateEmailSettingsInput } from './dto/update-email-settings.dto';
export type { EmailSettingsResponse } from './dto/email-settings-response.dto';
export type { TestEmailResult } from './dto/test-email-result.dto';

// `SecretRedactor` moved to `common/crypto/secret-redactor.ts` with #28 (epic
// #25) so the AI providers can share it. It is re-exported from
// `base-email.provider.ts` and therefore still reaches this barrel by its
// original path — every existing import is unchanged.
export {
  MAX_PROVIDER_ERROR_LENGTH,
  truncateProviderError,
} from '../common/crypto/secret-redactor';
