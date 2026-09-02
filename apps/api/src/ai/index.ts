// =============================================================================
// AI — public surface (issue #27/#28, epic #25)
// =============================================================================
//
// #27 shipped the declarations (settings shape, model-role registry,
// credential addresses); #28 adds the provider abstraction. Later issues add
// the services, the controllers and the concrete OpenAI provider behind this
// same barrel, so no call site changes its import path to get them.
//
// NOTHING EXPORTED FROM HERE CAN CARRY AN API KEY. `aiSettingsSchema` carries
// a compile-time proof that the persisted shape has no secret-bearing field,
// and the two credential addresses are exactly that — addresses. The keys
// themselves are reachable only through `CredentialsService.getSecret`, from
// server-side code, at the moment of use.
//
// `BaseAiProvider` is exported for the same reason it exists: a new provider
// extends it and inherits the never-throw guarantee. Implementing `AiProvider`
// directly is how that guarantee gets lost.
// =============================================================================

export { AiModule } from './ai.module';
export { AiSettingsController } from './ai-settings.controller';
export { AiUserKeyController } from './ai-user-key.controller';
export { AiUserKeyService } from './ai-user-key.service';
export { AiStatusService } from './ai-status.service';
export { AiSettingsService } from './ai-settings.service';
// AiConnectionTestService is deliberately NOT exported — see ai.module.ts.
export { BaseAiProvider } from './base-ai.provider';
export { OpenAiProvider } from './providers/openai.provider';
export {
  classifyModel,
  filterCatalog,
  parseGeneration,
  passesGenerationFloor,
} from './providers/model-classifier';
export {
  AI_SYSTEM_CREDENTIAL_LABEL,
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
  AI_USER_CREDENTIAL_LABEL,
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
export {
  AI_CAPABILITY_FAMILIES,
  AI_MODEL_ROLES,
  AI_MODEL_ROLE_KEYS,
  TEXT_CAPABILITY_FAMILIES,
  capabilityForRole,
  findModelRole,
  isModelRole,
  wiredModelRoles,
} from './ai-model-roles';
export {
  AI_PROVIDER_KINDS,
  AI_SETTINGS_KEY,
  DEFAULT_AI_SETTINGS,
  DEFAULT_MIN_MODEL_GENERATION,
  aiSettingsSchema,
} from './ai-settings.schema';

export type {
  AiCapabilityFamily,
  AiModelRole,
  AiModelRoleDef,
} from './ai-model-roles';
export type { AiProviderKind, AiSettings } from './ai-settings.schema';
export type {
  AiApiKeyStatus,
  AiSettingsAdminView,
} from './ai-settings.service';
export { aiSettingsResponseSchema } from './dto/ai-settings-response.dto';
export {
  aiModelCatalogResponseSchema,
  aiModelRoleSchema,
  aiModelSchema,
} from './dto/ai-model-catalog.dto';
export type { AiModelCatalogResponse } from './dto/ai-model-catalog.dto';
export {
  aiRoleReachabilitySchema,
  aiTestResultSchema,
} from './dto/ai-test-result.dto';
export type { AiTestResult } from './dto/ai-test-result.dto';
export {
  aiUserKeyStatusSchema,
  updateAiUserKeySchema,
} from './dto/ai-user-key.dto';
export type {
  AiUserKeyStatus,
  UpdateAiUserKeyInput,
} from './dto/ai-user-key.dto';
export { updateAiSettingsSchema } from './dto/update-ai-settings.dto';
export type { AiSettingsResponse } from './dto/ai-settings-response.dto';
export type { UpdateAiSettingsInput } from './dto/update-ai-settings.dto';
export type {
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiModelDescriptor,
  AiReachabilityRequest,
  AiReachabilityResult,
  AiUsage,
} from './ai.types';
export type {
  AiCapabilitySet,
  AiProvider,
} from './providers/ai-provider.interface';
export type { CatalogFilter } from './providers/model-classifier';
