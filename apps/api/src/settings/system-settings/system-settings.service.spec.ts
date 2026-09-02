import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';
import { systemSettingsResponseSchema } from '../dto/system-settings-response.dto';

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let mockPrisma: MockPrismaService;
  let mockConfigService: { get: jest.Mock };

  const mockUserId = 'user-123';
  const mockUser = {
    id: mockUserId,
    email: 'admin@example.com',
  };

  const mockSystemSettings = {
    id: 'settings-1',
    key: 'global',
    value: DEFAULT_SYSTEM_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: mockUserId,
    updatedByUser: mockUser,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    // Pass-through by default: `get(key, defaultValue)` returns `defaultValue`,
    // which mirrors ConfigService's real behaviour when nothing overrides the
    // key. Individual #148 tests below replace this with a table of real
    // values to prove the security block is read FROM config, not hardcoded.
    mockConfigService = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<SystemSettingsService>(SystemSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return current system settings with version', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result).toMatchObject({
        ui: DEFAULT_SYSTEM_SETTINGS.ui,
        features: DEFAULT_SYSTEM_SETTINGS.features,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(result.updatedBy).toEqual(mockUser);
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: { key: 'global' },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should create and return default settings when none exist', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUserId: null,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(result).toMatchObject({
        ui: DEFAULT_SYSTEM_SETTINGS.ui,
        features: DEFAULT_SYSTEM_SETTINGS.features,
        version: 1,
      });
      expect(mockPrisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          key: 'global',
          value: DEFAULT_SYSTEM_SETTINGS as any,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace entire settings', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: false },
        features: { newFeature: true },
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result).toMatchObject({
        ui: newSettings.ui,
        features: newSettings.features,
        version: 2,
      });
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'global' },
        update: {
          value: newSettings as any,
          updatedByUserId: mockUserId,
          version: { increment: 1 },
        },
        create: {
          key: 'global',
          value: newSettings as any,
          updatedByUserId: mockUserId,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: true },
        features: {},
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result.version).toBe(5);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on replace', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: false },
        features: {},
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.replaceSettings(newSettings, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:replace',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: {
            newValue: newSettings,
          } as any,
        },
      });
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.ui.allowUserThemeOverride).toBe(false);
      expect(result.features).toEqual(DEFAULT_SYSTEM_SETTINGS.features);
    });

    it('should handle features object merge', async () => {
      const existingWithFeatures = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          features: { existingFeature: true },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        existingWithFeatures as any,
      );

      const partialUpdate = {
        features: { newFeature: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: DEFAULT_SYSTEM_SETTINGS.ui,
          features: { existingFeature: true, newFeature: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.features).toEqual({
        existingFeature: true,
        newFeature: true,
      });
    });

    it('should throw ConflictException when If-Match version mismatch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(
        'Settings version mismatch. Expected 2, found 1',
      );

      // Should not call update when version mismatch
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when If-Match version matches', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        partialUpdate,
        mockUserId,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalled();
    });

    it('should increment version on patch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on patch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(partialUpdate, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:patch',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: expect.objectContaining({
            changes: partialUpdate,
            resultingValue: expect.any(Object),
          }) as any,
        },
      });
    });
  });

  // ===========================================================================
  // #130 — unknown keys in the 'global' row must survive a save.
  //
  // The rule pinned here: REQUEST BODIES STAY CLOSED; THE STORED VALUE IS
  // NEVER NARROWED. Two independent guarantees, tested separately on purpose
  // — proving only one would let a later change collapse them back together.
  // ===========================================================================
  describe('#130 unknown key preservation', () => {
    describe('the stored value is preserved (never narrowed)', () => {
      it('PATCH preserves an unknown top-level key while changing a feature flag', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true },
          features: {},
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: true },
            features: { newFlag: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings({ features: { newFlag: true } }, mockUserId);

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ui: { allowUserThemeOverride: true },
                features: { newFlag: true },
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('PATCH preserves an unknown key nested under ui (the only closed nested object)', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true, density: 'compact' },
          features: {},
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: false, density: 'compact' },
            features: {},
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { ui: { allowUserThemeOverride: false } },
          mockUserId,
        );

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ui: { allowUserThemeOverride: false, density: 'compact' },
                features: {},
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['ui.density'],
              }),
            }),
          }),
        );
      });

      it('PUT preserves unknown stored keys while replacing the known ones', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true },
          features: { oldFlag: true },
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ui: { allowUserThemeOverride: false },
          features: { newFlag: true },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const expectedValue = {
          branding: { logoUrl: 'https://example.com/logo.png' },
          ui: { allowUserThemeOverride: false },
          features: { newFlag: true },
        };

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: expectedValue }),
            create: expect.objectContaining({ value: expectedValue }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('known keys still win the merge — ui and features match the caller byte for byte', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true },
          features: { staleFlag: true },
          legacyBlob: { untouched: 1 },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ui: { allowUserThemeOverride: false },
          features: { freshFlag: true },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            legacyBlob: storedValue.legacyBlob,
          } as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;

        // Known keys are the caller's validated values, byte for byte — not
        // the stale stored ones — while the unknown key still survives.
        expect(upsertArgs.update.value.ui).toEqual(newSettings.ui);
        expect(upsertArgs.update.value.features).toEqual(newSettings.features);
        expect(upsertArgs.update.value.features.staleFlag).toBeUndefined();
        expect(upsertArgs.update.value.legacyBlob).toEqual({ untouched: 1 });
      });

      it('PUT against a missing row writes exactly the validated body, with no preserved keys', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(null as any);

        const newSettings: SystemSettingsValue = {
          ui: { allowUserThemeOverride: true },
          features: { onlyFlag: true },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: newSettings as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: newSettings }),
            create: expect.objectContaining({ value: newSettings }),
          }),
        );

        // No preservedKeys entry at all — not even an empty array — matching
        // the "should create audit event on replace" contract above.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:replace',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: { newValue: newSettings } as any,
          },
        });
      });

      it.each([
        ['a non-object (string)', 'not-an-object' as unknown],
        ['null', null as unknown],
      ])(
        'PUT does not break the save when the stored value is %s',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            value: malformed,
          } as any);

          const newSettings: SystemSettingsValue = {
            ui: { allowUserThemeOverride: true },
            features: {},
          };

          mockPrisma.systemSettings.upsert.mockResolvedValue({
            ...mockSystemSettings,
            value: newSettings as any,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          await expect(
            service.replaceSettings(newSettings, mockUserId),
          ).resolves.toBeDefined();

          expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({ value: newSettings }),
            }),
          );
        },
      );

      // Was a skipped repro ("BUG: PATCH throws on a null stored value
      // instead of tolerating it") written against the first #130 commit:
      // patchSettings dereferenced the RAW stored value directly —
      // `currentValue.ui.allowUserThemeOverride` and
      // `{ ...currentValue.features }` — to build `merged`, before
      // mergePreservingUnknown (and its defensive collectUnknownKeys guard)
      // ever ran. A malformed `system_settings.value` made PATCH throw an
      // unhandled TypeError instead of tolerating it. Fixed in a287737:
      // every read of the column now goes through the guarded
      // `readKnownSettings`/`asPlainObject` accessors, so this is now a
      // guarantee, not a defect — renamed and un-skipped accordingly.
      it.each([
        ['null', null as unknown],
        ['a string', 'not-an-object' as unknown],
        ['a number', 42 as unknown],
        ['an array', ['a', 'b'] as unknown],
      ])(
        'PATCH tolerates a stored value that is %s and falls back to defaults',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            ...mockSystemSettings,
            value: malformed as any,
          } as any);

          mockPrisma.systemSettings.update.mockResolvedValue({
            ...mockSystemSettings,
            value: {
              ui: DEFAULT_SYSTEM_SETTINGS.ui,
              features: { x: true },
            } as any,
            version: 2,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          const result = await service.patchSettings(
            { features: { x: true } },
            mockUserId,
          );

          expect(result).toBeDefined();
          expect(result.ui).toEqual(DEFAULT_SYSTEM_SETTINGS.ui);
          expect(result.features).toEqual({ x: true });

          // An array is an object to `typeof` — spreading one would write
          // `{'0':'a'}` into the row. Assert it does not.
          const updateArgs = mockPrisma.systemSettings.update.mock
            .calls[0][0] as any;
          expect(updateArgs.data.value).not.toHaveProperty('0');
          expect(updateArgs.data.value.features).toEqual({ x: true });
        },
      );
    });

    describe('a malformed stored value degrades field by field, not wholesale', () => {
      it('preserves a good features map when only ui is malformed', async () => {
        const storedValue = {
          ui: 'garbage' as unknown,
          features: { existingFeature: true },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: false },
            features: { existingFeature: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: false } },
          mockUserId,
        );

        // The malformed half (ui) fell back to the default and then took the
        // caller's change; the good half (features) survived untouched.
        expect(result.ui.allowUserThemeOverride).toBe(false);
        expect(result.features).toEqual({ existingFeature: true });
      });

      it('preserves a good ui value when only features is malformed', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true },
          features: 'garbage' as unknown,
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: true },
            features: { newFlag: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { features: { newFlag: true } },
          mockUserId,
        );

        // The good half (ui) survived untouched — a whole-object fallback
        // would have silently discarded it along with the malformed
        // features map.
        expect(result.ui.allowUserThemeOverride).toBe(true);
        expect(result.features).toEqual({ newFlag: true });
      });
    });

    describe('a partly malformed row still preserves unknown keys', () => {
      it('recovers top-level and ui.* unknown keys from the raw row even when features is unusable', async () => {
        const storedValue = {
          ui: { allowUserThemeOverride: true, density: 'compact' },
          features: 'garbage' as unknown,
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: true, density: 'compact' },
            features: { newFlag: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings({ features: { newFlag: true } }, mockUserId);

        // Preservation reads the RAW row, not the readKnownSettings
        // projection, so the unknown keys survive even though `features`
        // itself could not be parsed.
        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ui: { allowUserThemeOverride: true, density: 'compact' },
                features: { newFlag: true },
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding', 'ui.density'],
              }),
            }),
          }),
        );
      });
    });

    describe('the closed-body rule holds on the error path too', () => {
      it('an unknown key in the PATCH body never reaches storage when the stored value is malformed', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: null as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: DEFAULT_SYSTEM_SETTINGS.ui,
            features: { flag: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          features: { flag: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('request bodies stay closed', () => {
      it('an unknown key in a PUT body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: { ui: { allowUserThemeOverride: true }, features: {} },
        } as any);

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          ui: { allowUserThemeOverride: false },
          features: { flag: true },
          evilKey: 'should not be stored',
        };

        await service.replaceSettings(dtoWithUnknownKey as any, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;
        // Assert on what was actually PERSISTED, not on the return value —
        // the point is that the write itself is clean.
        expect(upsertArgs.update.value).not.toHaveProperty('evilKey');
        expect(upsertArgs.create.value).not.toHaveProperty('evilKey');
      });

      it('an unknown key in a PATCH body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          features: { flag: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock.calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('audit meta reporting', () => {
      it('omits preservedKeys from the audit meta on a normal patch save', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const partialUpdate = { features: { newFlag: true } };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: DEFAULT_SYSTEM_SETTINGS.ui,
            features: { newFlag: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(partialUpdate, mockUserId);

        // Exact match, same contract as "should create audit event on
        // replace" above: an always-present preservedKeys key would litter
        // every audit row, so it must be entirely absent on a normal save.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:patch',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: {
              changes: partialUpdate,
              resultingValue: {
                ui: DEFAULT_SYSTEM_SETTINGS.ui,
                features: { newFlag: true },
              },
            } as any,
          },
        });
      });
    });
  });

  // ===========================================================================
  // #148 — `systemSettingsResponseSchema` has always declared `security`, and
  // nothing ever populated it: GET, PUT and PATCH all omitted the key the
  // published OpenAPI contract promised. Fixed by `toResponse`, the one
  // projection now shared by all three methods, and `readSecurityPolicy`,
  // which reads `jwt.accessTtlMinutes` / `jwt.refreshTtlDays` off
  // ConfigService rather than the stored row.
  //
  // Covered on all three methods on purpose, per the bug: one hand-built
  // response shape wrong in three places at once means a test that only
  // covers GET cannot tell you PUT and PATCH are fixed too.
  // ===========================================================================
  describe('security block (#148)', () => {
    async function callGetSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      return service.getSettings();
    }

    async function callReplaceSettings() {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: true },
        features: {},
      };
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: DEFAULT_SYSTEM_SETTINGS,
      } as any);
      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.replaceSettings(newSettings, mockUserId);
    }

    async function callPatchSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.patchSettings({}, mockUserId);
    }

    const methods: Array<
      [string, () => ReturnType<typeof callGetSettings>]
    > = [
      ['getSettings', callGetSettings],
      ['replaceSettings (PUT)', callReplaceSettings],
      ['patchSettings (PATCH)', callPatchSettings],
    ];

    describe('the values are read from ConfigService, not hardcoded', () => {
      it.each(methods)(
        '%s surfaces the exact non-default numbers ConfigService returns',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (key: string, defaultValue?: unknown) => {
              if (key === 'jwt.accessTtlMinutes') return 45;
              if (key === 'jwt.refreshTtlDays') return 30;
              return defaultValue;
            },
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 45,
            refreshTtlDays: 30,
          });
        },
      );

      it.each(methods)(
        '%s asks ConfigService for the exact keys jwt.accessTtlMinutes and jwt.refreshTtlDays',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          await call();

          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.accessTtlMinutes',
            15,
          );
          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.refreshTtlDays',
            14,
          );
        },
      );
    });

    describe('the documented defaults (15/14) are used when ConfigService has nothing configured', () => {
      it.each(methods)(
        '%s still returns numbers, never undefined, for a response field typed z.number()',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 15,
            refreshTtlDays: 14,
          });
          expect(result.security.jwtAccessTtlMinutes).not.toBeUndefined();
          expect(result.security.refreshTtlDays).not.toBeUndefined();
        },
      );
    });

    describe('it is read-only: a security block in the request body is discarded, not persisted', () => {
      it('replaceSettings (PUT): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: DEFAULT_SYSTEM_SETTINGS,
        } as any);

        // The malicious/naive body: a client that read the OpenAPI contract
        // and assumed `security` was writable because the DTO declares it.
        const dtoWithSecurity = {
          ui: { allowUserThemeOverride: true },
          features: {},
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: { allowUserThemeOverride: true },
            features: {},
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        // Goes through the REAL validation path: systemSettingsSchema.parse
        // inside replaceSettings, exercised exactly as it is in production —
        // not a standalone assertion about what we assume zod does.
        const result = await service.replaceSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const upsertArgs = mockPrisma.systemSettings.upsert.mock
          .calls[0][0] as any;
        expect(upsertArgs.update.value).not.toHaveProperty('security');
        expect(upsertArgs.create.value).not.toHaveProperty('security');

        // The response carries config's numbers, not the submitted 9999s.
        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });

      it('patchSettings (PATCH): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const dtoWithSecurity = {
          features: { flag: true },
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ui: DEFAULT_SYSTEM_SETTINGS.ui,
            features: { flag: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('security');

        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });
    });

    describe('the response satisfies systemSettingsResponseSchema', () => {
      it.each(methods)(
        '%s output parses cleanly through the response schema the OpenAPI contract publishes',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          // Mirror the one normalisation a real HTTP response performs that
          // a plain object does not: `updatedAt` travels the wire as JSON,
          // which turns the Date into the ISO string
          // `systemSettingsResponseSchema` (z.iso.datetime()) declares.
          //
          // `updatedBy.id` is swapped for a real UUID for the same reason:
          // `mockUserId` ('user-123') is a fixture convenience used
          // throughout this file for equality checks, not a value meant to
          // satisfy `z.string().uuid()`. Substituting it here tests the
          // shape this change is responsible for — the security block and
          // the rest of the response — without this fixture's id format
          // being what's under test.
          const serialized = {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
            updatedBy: result.updatedBy && {
              ...result.updatedBy,
              id: '11111111-1111-4111-8111-111111111111',
            },
          };

          expect(() =>
            systemSettingsResponseSchema.parse(serialized),
          ).not.toThrow();
        },
      );
    });
  });

  describe('getSettingValue', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should get nested setting value by path', async () => {
      const value = await service.getSettingValue<boolean>(
        'ui.allowUserThemeOverride',
      );

      expect(value).toBe(DEFAULT_SYSTEM_SETTINGS.ui.allowUserThemeOverride);
    });

    it('should return undefined for non-existent path', async () => {
      const value = await service.getSettingValue<any>('ui.nonExistent');

      expect(value).toBeUndefined();
    });

    // #148 — new reach introduced by this change: `security` is now part of
    // the `getSettings()` projection this helper walks, so its fields become
    // addressable even though they were never part of `SystemSettingsValue`
    // or the stored row. Pinned here as a decision on record, not an
    // accident.
    it('addresses security.jwtAccessTtlMinutes through the config-backed security block', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: unknown) =>
          key === 'jwt.accessTtlMinutes' ? 45 : defaultValue,
      );

      const value = await service.getSettingValue<number>(
        'security.jwtAccessTtlMinutes',
      );

      expect(value).toBe(45);
    });

    it('addresses security.refreshTtlDays through the config-backed security block', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: unknown) =>
          key === 'jwt.refreshTtlDays' ? 30 : defaultValue,
      );

      const value = await service.getSettingValue<number>(
        'security.refreshTtlDays',
      );

      expect(value).toBe(30);
    });
  });

  describe('isFeatureEnabled', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          features: { featureA: true, featureB: false },
        } as any,
      } as any);
    });

    it('should return true for enabled feature', async () => {
      const result = await service.isFeatureEnabled('featureA');

      expect(result).toBe(true);
    });

    it('should return false for disabled feature', async () => {
      const result = await service.isFeatureEnabled('featureB');

      expect(result).toBe(false);
    });

    it('should return false for non-existent feature', async () => {
      const result = await service.isFeatureEnabled('featureC');

      expect(result).toBe(false);
    });
  });
});
