import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  AuthenticatedUser,
  RequestUser,
  toRequestUser,
} from '../interfaces/authenticated-user.interface';

/**
 * Extended Fastify request with user property
 */
interface FastifyRequestWithUser {
  user?: RequestUser | AuthenticatedUser;
  requestUser?: RequestUser;
}

/**
 * Narrow whatever the auth layer left on the request down to a {@link RequestUser}.
 *
 * WHY THIS NORMALIZATION EXISTS. `request.requestUser` is written by
 * `RolesGuard` and `PermissionsGuard`, but both of them return early when the
 * route declares no roles and no permissions — so on a bare `@Auth()` route
 * nothing sets it and the fallback is `request.user`, the full
 * `AuthenticatedUser` from the JWT strategy (or from `JwtAuthGuard`'s PAT
 * branch). That object carries its permissions in a nested
 * `userRoles[].role.rolePermissions[].permission` relation and has no
 * `permissions` array at all, so `@CurrentUser().permissions` was silently
 * `undefined` on exactly the routes that need to make their own authorization
 * decision in the service — the storage object routes being the live example.
 * Reading `undefined` as "holds nothing" fails closed, which is why it went
 * unnoticed, but it also makes any permission the route checks unreachable.
 *
 * `userRoles` is the discriminator: a `RequestUser` never has it, an
 * `AuthenticatedUser` always does.
 */
function normalize(
  user: RequestUser | AuthenticatedUser | undefined,
): RequestUser | undefined {
  if (!user) {
    return undefined;
  }

  if (Array.isArray((user as AuthenticatedUser).userRoles)) {
    return toRequestUser(user as AuthenticatedUser);
  }

  return user as RequestUser;
}

/**
 * Decorator to extract the current authenticated user from the request
 *
 * Always yields a {@link RequestUser} — `id`, `email`, `roles`, `permissions`
 * and `isActive` — whether the request was authorized by a guard that already
 * narrowed the user (`request.requestUser`) or only by `JwtAuthGuard`
 * (`request.user`). See {@link normalize} for why that matters.
 *
 * @example
 * ```typescript
 * // Get full user object
 * @Get('profile')
 * getProfile(@CurrentUser() user: RequestUser) {
 *   return user;
 * }
 *
 * // Get specific property
 * @Get('email')
 * getEmail(@CurrentUser('email') email: string) {
 *   return { email };
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<FastifyRequestWithUser>();
    const user = normalize(request.requestUser || request.user);

    return data ? user?.[data] : user;
  },
);
