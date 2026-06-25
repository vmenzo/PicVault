import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UploadService } from '../upload/upload.service';
import { formatUserPublicId } from '../../common/public-id';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number | string };
    photo?: Array<{ file_id: string; file_size?: number }>;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    caption?: string;
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPollAt?: Date;
  private lastError?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly upload: UploadService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.poll();
    }, 6000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async status() {
    const settings = await this.prisma.appSetting.findMany({
      where: {
        owner: {
          disabled: false,
        },
      },
      select: {
        ownerId: true,
        telegramBotEnabled: true,
        telegramBotToken: true,
        telegramAllowedChatIds: true,
        telegramLastUpdateId: true,
        owner: {
          select: {
            publicId: true,
          },
        },
      },
    });

    return {
      enabledAccounts: settings.filter(
        (setting) => setting.telegramBotEnabled && setting.telegramBotToken,
      ).length,
      running: this.running,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      accounts: settings.map((setting) => ({
        ownerId: setting.ownerId,
        ownerPublicId: formatUserPublicId(setting.owner.publicId),
        enabled: setting.telegramBotEnabled,
        configured: Boolean(setting.telegramBotToken),
        allowedChatIds: setting.telegramAllowedChatIds,
        lastUpdateId: setting.telegramLastUpdateId,
      })),
    };
  }

  async pollNow() {
    await this.poll();
    return this.status();
  }

  async test(ownerId: string) {
    const setting = await this.settings.getRuntime(ownerId);
    if (!setting.telegramBotToken) {
      return {
        ok: false,
        message: 'Bot Token 未配置',
      };
    }

    const me = await this.telegram<{
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    }>(setting.telegramBotToken, 'getMe', {});

    return {
      ok: true,
      bot: me,
    };
  }

  private async poll() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const settings = await this.prisma.appSetting.findMany({
        where: {
          telegramBotEnabled: true,
          telegramBotToken: { not: null },
          owner: {
            disabled: false,
          },
        },
      });

      for (const setting of settings) {
        await this.pollAccount(setting.ownerId, setting.telegramBotToken!);
      }
      this.lastPollAt = new Date();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(this.lastError);
    } finally {
      this.running = false;
    }
  }

  private async pollAccount(ownerId: string, token: string) {
    const setting = await this.settings.getRuntime(ownerId);
    if (!setting.telegramBotEnabled || !setting.telegramBotToken) {
      return;
    }

    const updates = await this.telegram<TelegramUpdate[]>(token, 'getUpdates', {
      timeout: 0,
      limit: 10,
      allowed_updates: ['message'],
      offset: setting.telegramLastUpdateId
        ? setting.telegramLastUpdateId + 1
        : undefined,
    });

    for (const update of updates) {
      await this.prisma.appSetting.update({
        where: { ownerId },
        data: { telegramLastUpdateId: update.update_id },
      });

      await this.handleUpdate(ownerId, token, setting, update);
    }
  }

  private async handleUpdate(
    ownerId: string,
    token: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
    update: TelegramUpdate,
  ) {
    const message = update.message;
    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    if (
      setting.telegramAllowedChatIds.length &&
      !setting.telegramAllowedChatIds.includes(chatId)
    ) {
      await this.sendMessage(token, chatId, '这个 Chat ID 未被允许上传。');
      return;
    }

    const file = this.pickImageFile(message);
    if (!file) {
      return;
    }

    try {
      const fileInfo = await this.telegram<{ file_path: string }>(
        token,
        'getFile',
        { file_id: file.fileId },
      );
      const response = await fetch(
        `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`,
        { signal: AbortSignal.timeout(30000) },
      );

      if (!response.ok) {
        throw new Error('Telegram file download failed');
      }

      const contentType =
        response.headers.get('content-type')?.split(';')[0] || file.contentType;
      const body = Buffer.from(await response.arrayBuffer());
      const image = await this.upload.createFromBuffer(ownerId, {
        filename: file.filename,
        contentType,
        body,
        albumId: setting.telegramAlbumId,
        visibility: setting.defaultVisibility,
        setting,
      });

      await this.sendMessage(token, chatId, `上传完成：${image.publicUrl}`);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(`Telegram upload failed: ${messageText}`);
      await this.sendMessage(token, chatId, `上传失败：${messageText}`);
    }
  }

  private pickImageFile(message: NonNullable<TelegramUpdate['message']>) {
    if (message.photo?.length) {
      const photo = [...message.photo].sort(
        (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
      )[0];

      return {
        fileId: photo.file_id,
        filename: `${Date.now()}.jpg`,
        contentType: 'image/jpeg',
      };
    }

    if (message.document?.mime_type?.startsWith('image/')) {
      return {
        fileId: message.document.file_id,
        filename: message.document.file_name || `${Date.now()}.jpg`,
        contentType: message.document.mime_type,
      };
    }

    return null;
  }

  private async sendMessage(token: string, chatId: string, text: string) {
    await this.telegram(token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  private async telegram<T = unknown>(
    token: string,
    method: string,
    payload: Record<string, unknown>,
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      },
    );

    const data = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }

    return data.result;
  }
}
