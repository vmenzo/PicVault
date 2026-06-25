import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { SettingsService } from '../settings/settings.service';
import { SessionService } from '../auth/session.service';

@Injectable()
export class UploadAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKey(request);

    if (apiKey) {
      const user = await this.apiKeys.authenticate(apiKey);
      if (!user) {
        throw new UnauthorizedException('Invalid API key');
      }

      const setting = await this.settings.getRuntime(user.id);
      if (!setting.apiUpload) {
        throw new ForbiddenException('API upload is disabled');
      }

      request.user = {
        id: user.id,
        publicId: user.publicId,
        email: user.email,
        role: user.role,
        authType: 'api-key',
      };
      return true;
    }

    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing credentials');
    }

    const user = await this.sessions.validate(token);
    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    request.user = {
      id: user.id,
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      authType: 'session',
    };
    return true;
  }

  private extractApiKey(request: {
    headers: Record<string, string | string[] | undefined>;
  }) {
    const header = request.headers['x-api-key'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value?.trim()) {
      return value.trim();
    }

    return null;
  }

  private extractBearerToken(request: {
    headers: Record<string, string | string[] | undefined>;
  }) {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const [type, token] = value?.split(' ') ?? [];
    return type?.toLowerCase() === 'bearer' && token ? token : null;
  }
}
