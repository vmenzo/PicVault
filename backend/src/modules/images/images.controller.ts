import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BulkImageActionDto } from './dto/bulk-image-action.dto';
import { ListImagesDto } from './dto/list-images.dto';
import { UpdateImageDto } from './dto/update-image.dto';
import { ImagesService } from './images.service';

@ApiTags('images')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload, @Query() query: ListImagesDto) {
    return this.images.list(user.id, query);
  }

  @Get('stats')
  stats(@CurrentUser() user: CurrentUserPayload) {
    return this.images.stats(user.id);
  }

  @Get('tags')
  tags(@CurrentUser() user: CurrentUserPayload) {
    return this.images.tags(user.id);
  }

  @Get(':id/asset')
  async asset(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.images.asset(user.id, id, variant);
    response.set({
      'Content-Type': file.contentType,
      'Cache-Control': 'private, max-age=60',
    });

    if (file.stream) {
      return new StreamableFile(file.stream);
    }

    return new StreamableFile(file.buffer!);
  }

  @Post('bulk')
  bulk(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: BulkImageActionDto,
  ) {
    return this.images.bulk(user.id, dto);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.images.restore(user.id, id);
  }

  @Post(':id/reprocess')
  reprocess(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.images.reprocess(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateImageDto,
  ) {
    return this.images.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.images.remove(user.id, id);
  }

  @Delete(':id/permanent')
  permanentRemove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ) {
    return this.images.permanentRemove(user.id, id);
  }
}

@ApiTags('public-images')
@Controller('public/images')
export class PublicImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get(':id')
  info(@Param('id') id: string) {
    return this.images.publicInfo(id);
  }

  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.images.download(id);
    const encoded = encodeURIComponent(file.filename);
    response.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    });

    return new StreamableFile(file.buffer);
  }
}
