import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';

describe('Storage Integration', () => {
  let context: TestContext;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  const mockStorageObjectId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID

  const mockStorageObject = {
    id: mockStorageObjectId,
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-123',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    mockStorageProvider = createMockStorageProvider();
    context = await createTestApp({ useMockDatabase: true });

    // Override storage provider with mock
    const storageProviderToken = context.module.get(STORAGE_PROVIDER, { strict: false });
    if (storageProviderToken) {
      Object.assign(storageProviderToken, mockStorageProvider);
    }
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
  });

  describe('POST /api/storage/objects/upload/init', () => {
    it('should initialize upload for authenticated user', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');

      context.prismaMock.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        objectId: 'new-obj-id',
        uploadId: 'upload-123',
        partSize: expect.any(Number),
        totalParts: expect.any(Number),
        presignedUrls: expect.any(Array),
      });
    });

    it('should return 401 for unauthenticated request', async () => {
      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);
    });

    it('should validate request body', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send({
          // Missing required fields
          name: 'test.pdf',
        })
        .expect(400);
    });
  });

  describe('GET /api/storage/objects/:id/upload/status', () => {
    it('should return upload status', async () => {
      const user = await createMockTestUser(context);

      const chunks = [
        { partNumber: 1, size: BigInt(10485760), eTag: 'etag1' },
        { partNumber: 2, size: BigInt(10485760), eTag: 'etag2' },
      ];

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        chunks,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        objectId: mockStorageObjectId,
        status: 'pending',
        uploadedParts: expect.any(Array),
        totalParts: expect.any(Number),
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/status')
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('should return 403 for non-owner', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(403);
    });
  });

  describe('POST /api/storage/objects/:id/upload/complete', () => {
    it('should complete upload', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      });
      context.prismaMock.storageObjectChunk.upsert.mockResolvedValue({});
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        status: 'processing',
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/complete')
        .set(authHeader(user.accessToken))
        .send({
          parts: [{ partNumber: 1, eTag: 'etag1' }],
        })
        .expect(404);
    });

    it('should validate parts array', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send({
          parts: 'invalid', // Should be array
        })
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id/upload/abort', () => {
    it('should abort upload', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        s3UploadId: 'upload-123',
      });
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}/upload/abort`)
        .set(authHeader(user.accessToken))
        .expect(200); // Note: Controller returns void but Fastify may default to 200
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/abort')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects', () => {
    it('should list user\'s objects', async () => {
      const user = await createMockTestUser(context);

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1', uploadedById: user.id },
        { ...mockStorageObject, id: 'obj-2', uploadedById: user.id },
      ];

      context.prismaMock.storageObject.findMany.mockResolvedValue(mockObjects);
      context.prismaMock.storageObject.count.mockResolvedValue(2);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 2,
        totalPages: 1,
      });
    });

    it('should support pagination', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([]);
      context.prismaMock.storageObject.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?page=2&pageSize=10')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.meta).toMatchObject({
        page: 2,
        pageSize: 10,
        totalItems: 50,
        totalPages: 5,
      });
    });

    it('should filter by status', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([
        { ...mockStorageObject, uploadedById: user.id, status: 'ready' },
      ]);
      context.prismaMock.storageObject.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?status=ready')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
    });
  });

  describe('GET /api/storage/objects/:id', () => {
    it('should return object metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        name: mockStorageObject.name,
        mimeType: mockStorageObject.mimeType,
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects/:id/download', () => {
    it('should return signed download URL', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'ready',
      });
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: 'https://signed-url.com/download',
        expiresIn: expect.any(Number),
      });
    });

    it('should return 400 for non-ready objects', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id', () => {
    it('should delete object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });
      mockStorageProvider.delete.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    describe('storage:delete_any', () => {
      const OTHER_OWNER_ID = 'someone-else-user-id';

      /** The object under test always belongs to somebody else. */
      function othersObject() {
        return { ...mockStorageObject, uploadedById: OTHER_OWNER_ID };
      }

      function stubSuccessfulDelete() {
        context.prismaMock.storageObject.findUnique.mockResolvedValue(
          othersObject(),
        );
        mockStorageProvider.delete.mockResolvedValue(undefined);
        context.prismaMock.storageObject.delete.mockResolvedValue({});
        context.prismaMock.auditEvent.create.mockResolvedValue({});
      }

      it("lets an Admin holding the permission delete another user's object", async () => {
        const admin = await createMockAdminUser(context);
        stubSuccessfulDelete();

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${mockStorageObjectId}`)
          .set(authHeader(admin.accessToken))
          .expect(204);

        expect(mockStorageProvider.delete).toHaveBeenCalledWith(
          mockStorageObject.storageKey,
        );
        expect(context.prismaMock.storageObject.delete).toHaveBeenCalledWith({
          where: { id: mockStorageObjectId },
        });
      });

      it('audits the cross-user delete with both user ids and the permission', async () => {
        const admin = await createMockAdminUser(context);
        stubSuccessfulDelete();

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${mockStorageObjectId}`)
          .set(authHeader(admin.accessToken))
          .expect(204);

        expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorUserId: admin.id,
            action: 'storage:object:delete',
            targetType: 'storage_object',
            targetId: mockStorageObjectId,
            meta: expect.objectContaining({
              ownerUserId: OTHER_OWNER_ID,
              overridePermission: 'storage:delete_any',
            }),
          }),
        });
      });

      it("refuses a Viewer, who does not hold it, on another user's object", async () => {
        const viewer = await createMockViewerUser(context);
        context.prismaMock.storageObject.findUnique.mockResolvedValue(
          othersObject(),
        );

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${mockStorageObjectId}`)
          .set(authHeader(viewer.accessToken))
          .expect(403);

        expect(mockStorageProvider.delete).not.toHaveBeenCalled();
        expect(context.prismaMock.storageObject.delete).not.toHaveBeenCalled();
      });

      it("refuses a Contributor, who does not hold it, on another user's object", async () => {
        const contributor = await createMockContributorUser(context);
        context.prismaMock.storageObject.findUnique.mockResolvedValue(
          othersObject(),
        );

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${mockStorageObjectId}`)
          .set(authHeader(contributor.accessToken))
          .expect(403);
      });

      it('leaves a self-delete unchanged, with no override in the audit row', async () => {
        const admin = await createMockAdminUser(context);

        context.prismaMock.storageObject.findUnique.mockResolvedValue({
          ...mockStorageObject,
          uploadedById: admin.id,
        });
        mockStorageProvider.delete.mockResolvedValue(undefined);
        context.prismaMock.storageObject.delete.mockResolvedValue({});
        context.prismaMock.auditEvent.create.mockResolvedValue({});

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${mockStorageObjectId}`)
          .set(authHeader(admin.accessToken))
          .expect(204);

        const meta = (context.prismaMock.auditEvent.create as jest.Mock).mock
          .calls[0][0].data.meta;
        expect(meta).not.toHaveProperty('ownerUserId');
        expect(meta).not.toHaveProperty('overridePermission');
      });

      // The override governs who may delete, never whether an id exists.
      it('404s on a missing object for holder and non-holder alike', async () => {
        const admin = await createMockAdminUser(context);
        const viewer = await createMockViewerUser(context);
        const missingId = '550e8400-e29b-41d4-a716-446655440002';

        context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${missingId}`)
          .set(authHeader(admin.accessToken))
          .expect(404);

        await request(context.app.getHttpServer())
          .delete(`/api/storage/objects/${missingId}`)
          .set(authHeader(viewer.accessToken))
          .expect(404);
      });
    });
  });

  /**
   * storage:delete_any is scoped to deletion by its name, and the
   * implementation keeps it there by giving delete its own authorization path
   * instead of threading a permission through the helper that read and write
   * share. These are the assertions that hold that line: if a future refactor
   * folds the override back into the shared helper, an Admin starts passing
   * these and they fail loudly.
   */
  describe('storage:delete_any does not widen read or write', () => {
    const OTHER_OWNER_ID = 'someone-else-user-id';

    beforeEach(() => {
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: OTHER_OWNER_ID,
      });
    });

    it("an Admin still cannot GET another user's object", async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(admin.accessToken))
        .expect(403);
    });

    it("an Admin still cannot get a download URL for another user's object", async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(admin.accessToken))
        .expect(403);

      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it("an Admin still cannot PATCH metadata on another user's object", async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(admin.accessToken))
        .send({ metadata: { tampered: true } })
        .expect(403);

      expect(context.prismaMock.storageObject.update).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/storage/objects/:id/metadata', () => {
    it('should update metadata', async () => {
      const user = await createMockTestUser(context);

      const newMetadata = {
        custom: 'value',
        tags: ['tag1', 'tag2'],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data', ...newMetadata },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: newMetadata })
        .expect(200);

      expect(response.body.data.metadata).toMatchObject({
        existing: 'data',
        custom: 'value',
      });
    });

    it('should merge with existing metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1', key2: 'value2' },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key2: 'value2' } })
        .expect(200);
    });
  });

  describe('Authentication', () => {
    it('should require authentication for all endpoints', async () => {
      // Test key endpoints without auth
      await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .expect(401);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);
    });
  });

  describe('Ownership validation', () => {
    it('should enforce ownership across all operations', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      // Mock object owned by another user
      const otherUserObject = {
        ...mockStorageObject,
        uploadedById: otherUserId,
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue(otherUserObject);

      // Test various endpoints
      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key: 'value' } })
        .expect(403);
    });
  });
});
