import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminGuard } from '../../common/admin.guard';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  MigrateImagesDto,
  ReprocessImagesDto,
} from './dto/storage-maintenance.dto';
import { MaintenanceService } from './maintenance.service';

@ApiTags('maintenance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('summary')
  summary() {
    return this.maintenance.summary();
  }

  @Post('reprocess')
  reprocess(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ReprocessImagesDto,
    @Req() request: Request,
  ) {
    return this.maintenance.reprocess(dto, {
      actorId: user.id,
      request,
    });
  }

  @Post('migrate')
  migrate(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: MigrateImagesDto,
    @Req() request: Request,
  ) {
    return this.maintenance.migrate(user.id, dto, {
      actorId: user.id,
      request,
    });
  }
}
