import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from './session.service';
import { formatUserPublicId } from '../../common/public-id';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    const user = await this.sessions.validate(token);
    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    request.user = {
      id: user.id,
      publicId: formatUserPublicId(user.publicId),
      email: user.email,
      role: user.role,
      authType: 'session',
    };
    return true;
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
