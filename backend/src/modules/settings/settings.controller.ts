import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { AdminGuard } from '../../common/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TestEmailDto } from './dto/test-email.dto';
import { UpdateAppSettingDto } from './dto/update-app-setting.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Admin-only full settings. Non-admin callers must use
   * GET /settings/upload-policy instead.
   *
   * BREAKING CHANGE (intentional): GET /settings/app previously returned
   * the 5-field upload policy for non-admin users. It is now admin-only
   * (403 for others); the policy moved to GET /settings/upload-policy,
   * which is what the frontend uses. No frontend non-admin caller of
   * this route remains.
   */
  @Get('app')
  @UseGuards(AdminGuard)
  get(@CurrentUser() user: CurrentUserPayload) {
    return this.settings.get(user.id);
  }

  /** Upload policy for any logged-in user (no secrets, no admin fields). */
  @Get('upload-policy')
  getUploadPolicy(@CurrentUser() user: CurrentUserPayload) {
    return this.settings.getUploadPolicy(user.id);
  }

  @Patch('app')
  @UseGuards(AdminGuard)
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: UpdateAppSettingDto,
  ) {
    return this.settings.update(user.id, dto);
  }

  @Post('app/storage-test')
  @UseGuards(AdminGuard)
  testStorage(@CurrentUser() user: CurrentUserPayload) {
    return this.settings.testStorage(user.id);
  }

  @Post('app/email-test')
  @UseGuards(AdminGuard)
  testEmail(@Body() dto: TestEmailDto) {
    return this.settings.testEmail(dto.email);
  }
}
