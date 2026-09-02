import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';

import { CurrentUser } from './current-user.decorator';
import { RequestUser } from '../interfaces/authenticated-user.interface';

/**
 * Pull the factory out of a `createParamDecorator` result so it can be called
 * directly with a fake ExecutionContext.
 */
function getFactory(): (
  data: unknown,
  ctx: ExecutionContext,
) => RequestUser | undefined {
  class Probe {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    handler(@CurrentUser() _user: RequestUser) {}
  }

  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Probe,
    'handler',
  ) as Record<string, { factory: (data: unknown, ctx: ExecutionContext) => any }>;

  return args[Object.keys(args)[0]].factory;
}

function contextFor(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('@CurrentUser()', () => {
  const factory = getFactory();

  const roleWithPermissions = {
    id: 'role-admin',
    name: 'admin',
    description: 'Full system access',
    rolePermissions: [
      { permission: { id: 'p1', name: 'users:read', description: null } },
      {
        permission: {
          id: 'p2',
          name: 'storage:delete_any',
          description: null,
        },
      },
    ],
  };

  /**
   * The AuthenticatedUser shape the JWT strategy (and JwtAuthGuard's PAT
   * branch) leaves on `request.user`. Permissions live in a nested relation,
   * not in a flat array.
   */
  const authenticatedUser = {
    id: 'user-1',
    email: 'admin@example.com',
    isActive: true,
    userRoles: [{ role: roleWithPermissions }],
  };

  it('returns the narrowed user a guard already attached', () => {
    const requestUser: RequestUser = {
      id: 'user-1',
      email: 'admin@example.com',
      roles: ['admin'],
      permissions: ['users:read'],
      isActive: true,
    };

    const result = factory(undefined, contextFor({ requestUser }));

    expect(result).toBe(requestUser);
  });

  // This is the regression guard for the silent gap that made an in-service
  // permission check unreachable: RolesGuard and PermissionsGuard return early
  // on a bare `@Auth()` route, so nothing sets `request.requestUser` and the
  // fallback is the raw AuthenticatedUser.
  it('narrows the raw AuthenticatedUser when no guard attached one', () => {
    const result = factory(undefined, contextFor({ user: authenticatedUser }));

    expect(result).toEqual({
      id: 'user-1',
      email: 'admin@example.com',
      roles: ['admin'],
      permissions: ['users:read', 'storage:delete_any'],
      isActive: true,
    });
  });

  it('exposes permissions as an array on a route with no permission metadata', () => {
    const result = factory(undefined, contextFor({ user: authenticatedUser }));

    expect(Array.isArray(result?.permissions)).toBe(true);
    expect(result?.permissions).toContain('storage:delete_any');
  });

  it('extracts a single property', () => {
    expect(factory('id', contextFor({ user: authenticatedUser }))).toBe(
      'user-1',
    );
    expect(factory('email', contextFor({ user: authenticatedUser }))).toBe(
      'admin@example.com',
    );
  });

  it('returns undefined when the request carries no user', () => {
    expect(factory(undefined, contextFor({}))).toBeUndefined();
    expect(factory('id', contextFor({}))).toBeUndefined();
  });
});
