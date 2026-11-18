import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { AdminGuard } from '../../common/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SystemService } from './system.service';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('ping')
  ping() {
    return this.system.ping();
  }

  /**
   * Unauthenticated readiness probe (DB + Redis). Intentionally separate
   * from the admin-only /health endpoint, which exposes counts and
   * storage details. Used by the frontend /healthz and /readyz handlers
   * and by docker-compose healthchecks.
   */
  @Get('ready')
  readiness() {
    return this.system.readiness();
  }

  @Get('health')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminGuard)
  health(@CurrentUser() user: CurrentUserPayload) {
    return this.system.health(user.id);
  }
}
