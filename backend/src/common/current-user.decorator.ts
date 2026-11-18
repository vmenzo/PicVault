import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type CurrentUserPayload = {
  id: string;
  // Formatted public id (e.g. "000123"), matching serializeUser() and the
  // frontend User/AdminUser types. The raw Prisma int must never be
  // exposed here: guards format it with formatUserPublicId().
  publicId?: string;
  email: string;
  role: string;
  authType?: 'session' | 'api-key';
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload => {
    const request = context.switchToHttp().getRequest();
    return request.user;
  },
);
