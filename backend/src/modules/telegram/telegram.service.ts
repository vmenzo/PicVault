import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageStatus, StorageProvider, Visibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UploadService } from '../upload/upload.service';
import { StorageService } from '../storage/storage.service';
import { formatUserPublicId } from '../../common/public-id';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    caption?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number | string };
    };
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type TelegramPanel = {
  text: string;
  keyboard?: InlineKeyboardButton[][];
};

const CALLBACK_PREFIX = 'pv:';

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
    private readonly storage: StorageService,
    private readonly config: ConfigService,
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
      allowed_updates: ['message', 'callback_query'],
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
    if (update.callback_query) {
      const callbackChatId = update.callback_query.message?.chat.id;
      if (
        callbackChatId !== undefined &&
        setting.telegramAllowedChatIds.length &&
        !setting.telegramAllowedChatIds.includes(String(callbackChatId))
      ) {
        await this.answerCallback(
          token,
          update.callback_query.id,
          '这个 Chat ID 未被允许操作。',
          true,
        );
        return;
      }

      await this.handleCallback(ownerId, token, setting, update.callback_query);
      return;
    }

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

    if (message.text?.trim()) {
      await this.handleTextCommand(
        ownerId,
        token,
        setting,
        chatId,
        message.text,
      );
      return;
    }

    const file = this.pickImageFile(message);
    if (!file) {
      await this.sendPanel(
        token,
        chatId,
        this.helpPanel('发送图片可直接上传，或使用下面的控制台操作。'),
      );
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
      const canOpenPublic = this.isPublicReadyImage(image);

      await this.sendPanel(token, chatId, {
        text: [
          'PicVault 上传完成',
          '',
          `文件：${image.originalName}`,
          `大小：${this.formatBytes(Number(image.sizeBytes))}`,
          `可见性：${this.visibilityText(image.visibility)}`,
          this.publicLinkLine(image, setting),
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: [
          ...(canOpenPublic
            ? [
                [
                  {
                    text: '打开图片',
                    url: this.imagePublicUrl(image, setting),
                  },
                  {
                    text: '分享页',
                    url: this.shareUrl(image.id, setting),
                  },
                ],
              ]
            : []),
          [
            { text: '最近图片', callback_data: 'pv:recent' },
            { text: '控制台', callback_data: 'pv:home' },
          ],
        ],
      });
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

  private async handleTextCommand(
    ownerId: string,
    token: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
    chatId: string,
    text: string,
  ) {
    const command = text.trim().split(/\s+/)[0].toLowerCase().split('@')[0];
    const panel =
      command === '/start' || command === '/panel' || command === '/menu'
        ? await this.homePanel(ownerId, setting)
        : command === '/status'
          ? await this.statusPanel(ownerId, setting)
          : command === '/recent'
            ? await this.recentPanel(ownerId, setting)
            : command === '/albums'
              ? await this.albumsPanel(ownerId)
              : command === '/policy'
                ? this.policyPanel(setting)
                : command === '/help'
                  ? this.helpPanel()
                  : this.helpPanel('未知命令。');

    await this.sendPanel(token, chatId, panel);
  }

  private async handleCallback(
    ownerId: string,
    token: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
    callback: NonNullable<TelegramUpdate['callback_query']>,
  ) {
    const callbackMessage = callback.message;
    const chatId = callbackMessage?.chat.id;
    if (!callbackMessage || !chatId) {
      await this.answerCallback(token, callback.id);
      return;
    }

    const data = callback.data ?? '';
    if (!data.startsWith(CALLBACK_PREFIX)) {
      await this.answerCallback(token, callback.id);
      return;
    }

    const action = data.slice(CALLBACK_PREFIX.length);
    let panel: TelegramPanel;
    if (action === 'home') {
      panel = await this.homePanel(ownerId, setting);
    } else if (action === 'status') {
      panel = await this.statusPanel(ownerId, setting);
    } else if (action === 'recent') {
      panel = await this.recentPanel(ownerId, setting);
    } else if (action === 'albums') {
      panel = await this.albumsPanel(ownerId);
    } else if (action === 'policy') {
      panel = this.policyPanel(setting);
    } else if (action.startsWith('vis:')) {
      const visibility = action.slice('vis:'.length) as Visibility;
      panel = await this.updateDefaultVisibility(ownerId, visibility);
    } else {
      panel = this.helpPanel('未知操作。');
    }

    await this.answerCallback(token, callback.id);
    await this.editOrSendPanel(
      token,
      String(chatId),
      callbackMessage.message_id,
      panel,
    );
  }

  private async homePanel(
    ownerId: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): Promise<TelegramPanel> {
    const [user, counts] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: {
          publicId: true,
          email: true,
          name: true,
          quotaBytes: true,
          usedBytes: true,
        },
      }),
      this.prisma.image.groupBy({
        by: ['status'],
        where: { ownerId },
        _count: { _all: true },
      }),
    ]);
    const countMap = new Map(
      counts.map((item) => [item.status, item._count._all]),
    );

    return {
      text: [
        'PicVault 控制台',
        '',
        `${user.name} · ${formatUserPublicId(user.publicId)}`,
        `邮箱：${user.email}`,
        `容量：${this.formatBytes(Number(user.usedBytes))} / ${this.formatBytes(
          Number(user.quotaBytes),
        )}`,
        `图片：${countMap.get(ImageStatus.READY) ?? 0} 可访问，${
          countMap.get(ImageStatus.PROCESSING) ?? 0
        } 处理中，${countMap.get(ImageStatus.FAILED) ?? 0} 失败`,
        `默认可见性：${this.visibilityText(setting.defaultVisibility)}`,
      ].join('\n'),
      keyboard: this.mainKeyboard(),
    };
  }

  private async statusPanel(
    ownerId: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): Promise<TelegramPanel> {
    const stats = await this.imageStats(ownerId);
    return {
      text: [
        '系统状态',
        '',
        `存储：${setting.storageProvider}`,
        `单图上限：${this.formatBytes(setting.maxSizeBytes)}`,
        `默认可见性：${this.visibilityText(setting.defaultVisibility)}`,
        `API 上传：${setting.apiUpload ? '开启' : '关闭'}`,
        `图片：${stats.total} 总数，${stats.ready} 可访问，${stats.pending} 待处理，${stats.failed} 失败，${stats.deleted} 回收站`,
        `容量：${this.formatBytes(stats.usedBytes)} / ${this.formatBytes(
          stats.quotaBytes,
        )}`,
      ].join('\n'),
      keyboard: [
        [
          { text: '最近图片', callback_data: 'pv:recent' },
          { text: '上传策略', callback_data: 'pv:policy' },
        ],
        [{ text: '返回控制台', callback_data: 'pv:home' }],
      ],
    };
  }

  private async recentPanel(
    ownerId: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): Promise<TelegramPanel> {
    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        status: { not: ImageStatus.DELETED },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        title: true,
        originalName: true,
        sizeBytes: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        createdAt: true,
      },
    });

    return {
      text:
        images.length > 0
          ? [
              '最近图片',
              '',
              ...images.map(
                (image, index) =>
                  `${index + 1}. ${image.title || image.originalName}\n` +
                  `   ${this.statusText(image.status)} · ${this.visibilityText(
                    image.visibility,
                  )} · ${this.formatBytes(Number(image.sizeBytes))}\n` +
                  `   ${this.publicLinkLine(image, setting)}`,
              ),
            ].join('\n')
          : '最近图片\n\n暂无图片。',
      keyboard: [
        ...images
          .filter((image) => this.isPublicReadyImage(image))
          .slice(0, 3)
          .map((image) => [
            {
              text: `打开：${image.title}`,
              url: this.imagePublicUrl(image, setting),
            },
            { text: '分享页', url: this.shareUrl(image.id, setting) },
          ]),
        [{ text: '返回控制台', callback_data: 'pv:home' }],
      ],
    };
  }

  private async albumsPanel(ownerId: string): Promise<TelegramPanel> {
    const albums = await this.prisma.album.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        _count: {
          select: { images: true },
        },
      },
    });

    return {
      text:
        albums.length > 0
          ? [
              '相册',
              '',
              ...albums.map(
                (album, index) =>
                  `${index + 1}. ${album.name} · ${album._count.images} 张 · ${this.visibilityText(
                    album.visibility,
                  )}`,
              ),
            ].join('\n')
          : '相册\n\n暂无相册。',
      keyboard: [
        [
          { text: '最近图片', callback_data: 'pv:recent' },
          { text: '返回控制台', callback_data: 'pv:home' },
        ],
      ],
    };
  }

  private policyPanel(
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): TelegramPanel {
    return {
      text: [
        '上传策略',
        '',
        `存储：${setting.storageProvider}`,
        `单图上限：${this.formatBytes(setting.maxSizeBytes)}`,
        `允许类型：${setting.allowedTypes.join(', ') || 'image/*'}`,
        `默认可见性：${this.visibilityText(setting.defaultVisibility)}`,
        `缩略图：${setting.generateThumbnail ? '生成' : '不生成'}`,
        `WebP：${setting.generateWebp ? '生成' : '不生成'}`,
        `AVIF：${setting.generateAvif ? '生成' : '不生成'}`,
      ].join('\n'),
      keyboard: [
        [
          { text: '设为私有', callback_data: 'pv:vis:PRIVATE' },
          { text: '设为公开', callback_data: 'pv:vis:PUBLIC' },
        ],
        [
          { text: '设为隐藏链接', callback_data: 'pv:vis:UNLISTED' },
          { text: '返回控制台', callback_data: 'pv:home' },
        ],
      ],
    };
  }

  private helpPanel(prefix?: string): TelegramPanel {
    return {
      text: [
        prefix,
        'PicVault Telegram 控制台',
        '',
        '发送图片：直接上传到图床',
        '/panel：打开控制台',
        '/status：查看状态和容量',
        '/recent：查看最近图片',
        '/albums：查看相册',
        '/policy：查看上传策略',
        '/help：查看帮助',
      ]
        .filter(Boolean)
        .join('\n'),
      keyboard: this.mainKeyboard(),
    };
  }

  private async updateDefaultVisibility(
    ownerId: string,
    visibility: Visibility,
  ): Promise<TelegramPanel> {
    if (!Object.values(Visibility).includes(visibility)) {
      return this.helpPanel('可见性参数无效。');
    }

    await this.settings.update(ownerId, { defaultVisibility: visibility });
    const setting = await this.settings.getRuntime(ownerId);
    return this.policyPanel(setting);
  }

  private async imageStats(ownerId: string) {
    const [total, ready, pending, failed, deleted, user] =
      await this.prisma.$transaction([
        this.prisma.image.count({
          where: { ownerId, status: { not: ImageStatus.DELETED } },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.READY },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: { in: [ImageStatus.PENDING, ImageStatus.PROCESSING] },
          },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.FAILED },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.DELETED },
        }),
        this.prisma.user.findUniqueOrThrow({
          where: { id: ownerId },
          select: { quotaBytes: true, usedBytes: true },
        }),
      ]);

    return {
      total,
      ready,
      pending,
      failed,
      deleted,
      usedBytes: Number(user.usedBytes),
      quotaBytes: Number(user.quotaBytes),
    };
  }

  private mainKeyboard(): InlineKeyboardButton[][] {
    return [
      [
        { text: '状态', callback_data: 'pv:status' },
        { text: '最近图片', callback_data: 'pv:recent' },
      ],
      [
        { text: '相册', callback_data: 'pv:albums' },
        { text: '上传策略', callback_data: 'pv:policy' },
      ],
    ];
  }

  private async sendMessage(token: string, chatId: string, text: string) {
    await this.telegram(token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  private async sendPanel(token: string, chatId: string, panel: TelegramPanel) {
    await this.telegram(token, 'sendMessage', {
      chat_id: chatId,
      text: panel.text,
      disable_web_page_preview: true,
      reply_markup: panel.keyboard
        ? {
            inline_keyboard: panel.keyboard,
          }
        : undefined,
    });
  }

  private async editOrSendPanel(
    token: string,
    chatId: string,
    messageId: number,
    panel: TelegramPanel,
  ) {
    try {
      await this.telegram(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: panel.text,
        disable_web_page_preview: true,
        reply_markup: panel.keyboard
          ? {
              inline_keyboard: panel.keyboard,
            }
          : undefined,
      });
    } catch {
      await this.sendPanel(token, chatId, panel);
    }
  }

  private async answerCallback(
    token: string,
    id: string,
    text?: string,
    showAlert = false,
  ) {
    const payload: Record<string, unknown> = {
      callback_query_id: id,
    };
    if (text) {
      payload.text = text;
      payload.show_alert = showAlert;
    }

    await this.telegram(token, 'answerCallbackQuery', payload);
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

  private absoluteUrl(
    value?: string | null,
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (!value) return '';
    try {
      return new URL(value, this.publicAppUrl(setting)).toString();
    } catch {
      return value;
    }
  }

  private shareUrl(
    imageId: string,
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    return new URL(`/s/${imageId}`, this.publicAppUrl(setting)).toString();
  }

  private isPublicReadyImage(image: {
    visibility: Visibility;
    status: ImageStatus;
  }) {
    return (
      image.visibility !== Visibility.PRIVATE &&
      image.status === ImageStatus.READY
    );
  }

  private publicLinkLine(
    image: {
      storageKey: string;
      storageProvider: StorageProvider;
      visibility: Visibility;
      status: ImageStatus;
    },
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (this.isPublicReadyImage(image)) {
      return `链接：${this.imagePublicUrl(image, setting)}`;
    }

    if (image.visibility === Visibility.PRIVATE) {
      return '链接：私有图片不生成公开链接';
    }

    return '链接：图片处理完成后可访问';
  }

  private imagePublicUrl(
    image: { storageKey: string; storageProvider: StorageProvider },
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    return this.absoluteUrl(
      this.storage.getPublicUrlWithBase(image.storageKey, {
        ...setting,
        storageProvider: image.storageProvider,
      }),
      setting,
    );
  }

  private publicAppUrl(
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    return (
      setting?.appPublicUrl?.trim() ||
      this.config.get<string>('APP_PUBLIC_URL')?.trim() ||
      'http://127.0.0.1:7899'
    );
  }

  private formatBytes(bytes = 0) {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const value = bytes / 1024 ** index;
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${
      units[index]
    }`;
  }

  private visibilityText(value: Visibility) {
    return (
      {
        [Visibility.PRIVATE]: '私有',
        [Visibility.PUBLIC]: '公开',
        [Visibility.UNLISTED]: '隐藏链接',
      }[value] ?? value
    );
  }

  private statusText(value: ImageStatus) {
    return (
      {
        [ImageStatus.PENDING]: '待处理',
        [ImageStatus.PROCESSING]: '处理中',
        [ImageStatus.READY]: '可访问',
        [ImageStatus.FAILED]: '失败',
        [ImageStatus.DELETED]: '回收站',
      }[value] ?? value
    );
  }
}
