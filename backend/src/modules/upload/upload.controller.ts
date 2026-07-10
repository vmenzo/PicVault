import {
  Body,
  Controller,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { CreateUploadDto } from './dto/create-upload.dto';
import { ImportUrlDto } from './dto/import-url.dto';
import { UploadObjectParamsDto } from './dto/upload-object-params.dto';
import { UploadAuthGuard } from './upload-auth.guard';
import { UploadService } from './upload.service';

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(UploadAuthGuard)
@Controller('upload')
export class UploadController {
  constructor(private readonly upload: UploadService) {}

  @Post('sign')
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateUploadDto,
  ) {
    return this.upload.create(user.id, dto);
  }

  @Post('import-url')
  importUrl(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ImportUrlDto,
  ) {
    return this.upload.importUrl(user.id, dto);
  }

  @Put(':key/object')
  async uploadObject(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: UploadObjectParamsDto,
    @Req() request: Request,
  ) {
    const key = decodeURIComponent(params.key);
    return this.upload.uploadObjectStream(
      user.id,
      key,
      request,
      request.headers['content-type']?.split(';')[0] ?? '',
    );
  }

  @Post(':id/complete')
  complete(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.upload.complete(user.id, id);
  }
}
