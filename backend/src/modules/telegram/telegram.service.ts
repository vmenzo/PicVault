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
  copy_text?: {
    text: string;
  };
};

type TelegramPanel = {
  text: string;
  keyboard?: InlineKeyboardButton[][];
  previews?: TelegramPreview[];
  parseMode?: 'HTML';
};

type TelegramPreview = {
  title: string;
  ownerId: string;
  storageKey: string;
  storageProvider: StorageProvider;
  contentType: string;
  imageUrl?: string;
  shareUrl?: string;
};

type TelegramUrlSetting = {
  publicBaseUrl?: string | null;
  appPublicUrl?: string | null;
  storageProvider?: StorageProvider;
};

type TelegramRuntimeSetting = Awaited<
  ReturnType<SettingsService['getRuntime']>
>;

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
    }, 2000);
    void this.poll();
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

      const results = await Promise.allSettled(
        settings.map((setting) =>
          this.pollAccount(setting.ownerId, setting.telegramBotToken!),
        ),
      );
      const errors = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        .map((result) =>
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );
      this.lastPollAt = new Date();
      this.lastError = errors.length ? errors.join('\n') : undefined;
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
      timeout: 10,
      limit: 50,
      allowed_updates: ['message', 'callback_query'],
      offset: setting.telegramLastUpdateId
        ? setting.telegramLastUpdateId + 1
        : undefined,
    });

    for (const update of updates) {
      try {
        await this.handleUpdate(ownerId, token, setting, update);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.logger.warn(
          `Telegram update ${update.update_id} failed: ${message}`,
        );
      } finally {
        await this.prisma.appSetting.update({
          where: { ownerId },
          data: { telegramLastUpdateId: update.update_id },
        });
      }
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
      const displayImage =
        (await this.waitForImage(ownerId, image.id, 5000)) ?? image;
      const links = this.publicLinksForImage(displayImage, setting);
      const markdown = links.imageUrl
        ? `![${displayImage.originalName}](${links.imageUrl})`
        : '';
      const nodeseek = links.imageUrl ? `![](${links.imageUrl})` : '';

      await this.sendPanel(token, chatId, {
        text: [
          'PicVault 上传完成',
          '',
          `文件：${this.escapeHtml(displayImage.originalName)}`,
          `大小：${this.formatBytes(Number(displayImage.sizeBytes))}`,
          `状态：${this.statusText(displayImage.status)}`,
          `可见性：${this.visibilityText(displayImage.visibility)}`,
          this.publicLinkCopyLine(displayImage, setting),
          links.shareUrl ? `分享页： ${this.copyCode(links.shareUrl)}` : '',
          markdown ? `Markdown： ${this.copyCode(markdown)}` : '',
          nodeseek ? this.nodeSeekCopyLine(links.imageUrl) : '',
        ]
          .filter(Boolean)
          .join('\n'),
        parseMode: 'HTML',
        keyboard: [
          ...(links.imageUrl && links.shareUrl
            ? [
                [
                  {
                    text: '打开图片',
                    url: links.imageUrl,
                  },
                  {
                    text: '分享页',
                    url: links.shareUrl,
                  },
                ],
              ]
            : []),
          [
            { text: '链接格式', callback_data: 'pv:links' },
            { text: '返回', callback_data: 'pv:home' },
          ],
        ],
        previews: [this.previewForImage(ownerId, displayImage, setting)].filter(
          (preview): preview is TelegramPreview => Boolean(preview),
        ),
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
    const trimmed = text.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      await this.sendPanel(
        token,
        chatId,
        await this.grabUrlPanel(ownerId, setting, trimmed),
      );
      return;
    }

    const [rawCommand = '', ...args] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase().split('@')[0];
    const argument = args.join(' ').trim();
    let panel: TelegramPanel;
    switch (command) {
      case '/start':
      case '/panel':
      case '/menu':
        panel = await this.homePanel(ownerId, setting);
        break;
      case '/console':
        panel = await this.homePanel(ownerId, setting);
        break;
      case '/library':
        panel = await this.libraryPanel(ownerId, setting);
        break;
      case '/search':
        panel = await this.searchPanel(ownerId, setting, argument);
        break;
      case '/grab':
        panel = await this.grabUrlPanel(ownerId, setting, argument);
        break;
      case '/status':
        panel = await this.statusPanel(ownerId, setting);
        break;
      case '/integrations':
        panel = await this.integrationPanel(ownerId, setting, chatId);
        break;
      case '/recent':
        panel = await this.recentPanel(ownerId, setting);
        break;
      case '/links':
        panel = await this.linksPanel(ownerId, setting);
        break;
      case '/albums':
        panel = await this.albumsPanel(ownerId, setting);
        break;
      case '/location':
        panel = await this.uploadLocationPanel(ownerId, setting);
        break;
      case '/keys':
        panel = await this.apiKeysPanel(ownerId, setting);
        break;
      case '/trash':
        panel = await this.trashPanel(ownerId, setting);
        break;
      case '/policy':
      case '/visibility':
        panel = this.policyPanel(setting);
        break;
      case '/upload':
        panel = this.uploadGuidePanel(setting);
        break;
      case '/site':
        panel = this.sitePanel(setting);
        break;
      case '/public':
        panel = await this.updateDefaultVisibility(ownerId, Visibility.PUBLIC);
        break;
      case '/private':
        panel = await this.updateDefaultVisibility(ownerId, Visibility.PRIVATE);
        break;
      case '/unlisted':
        panel = await this.updateDefaultVisibility(
          ownerId,
          Visibility.UNLISTED,
        );
        break;
      case '/help':
        panel = this.helpPanel(undefined, setting);
        break;
      default:
        panel = command.startsWith('/')
          ? this.helpPanel('未知命令。', setting)
          : await this.searchPanel(ownerId, setting, trimmed);
    }

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
    await this.answerCallback(token, callback.id).catch(() => undefined);

    let panel: TelegramPanel;
    if (action === 'home') {
      panel = await this.homePanel(ownerId, setting);
    } else if (action === 'console' || action === 'refresh') {
      panel = await this.homePanel(ownerId, setting);
    } else if (action === 'status') {
      panel = await this.statusPanel(ownerId, setting);
    } else if (action === 'integrations') {
      panel = await this.integrationPanel(ownerId, setting, String(chatId));
    } else if (action === 'library') {
      panel = await this.libraryPanel(ownerId, setting);
    } else if (action.startsWith('img:')) {
      panel = await this.imagePanel(
        ownerId,
        setting,
        action.slice('img:'.length),
      );
    } else if (action === 'search') {
      panel = await this.searchPanel(ownerId, setting, '');
    } else if (action === 'grab') {
      panel = await this.grabUrlPanel(ownerId, setting, '');
    } else if (action === 'recent') {
      panel = await this.recentPanel(ownerId, setting);
    } else if (action === 'links') {
      panel = await this.linksPanel(ownerId, setting);
    } else if (action.startsWith('link:')) {
      panel = await this.linkFormatPanel(
        ownerId,
        setting,
        action.slice('link:'.length),
      );
    } else if (action === 'albums') {
      panel = await this.albumsPanel(ownerId, setting);
    } else if (action === 'location') {
      panel = await this.uploadLocationPanel(ownerId, setting);
    } else if (action.startsWith('album:')) {
      panel = await this.updateTelegramAlbum(
        ownerId,
        action.slice('album:'.length),
      );
    } else if (action.startsWith('storage:')) {
      panel = await this.updateStorageProvider(
        ownerId,
        action.slice('storage:'.length),
      );
    } else if (action === 'keys') {
      panel = await this.apiKeysPanel(ownerId, setting);
    } else if (action === 'trash') {
      panel = await this.trashPanel(ownerId, setting);
    } else if (action === 'policy') {
      panel = this.policyPanel(setting);
    } else if (action === 'upload') {
      panel = this.uploadGuidePanel(setting);
    } else if (action === 'site') {
      panel = this.sitePanel(setting);
    } else if (action.startsWith('vis:')) {
      const visibility = action.slice('vis:'.length) as Visibility;
      panel = await this.updateDefaultVisibility(ownerId, visibility);
    } else {
      panel = this.helpPanel('未知操作。');
    }

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
        where: { ownerId, uploadedAt: { not: null } },
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
        '实时文字台',
        `${user.name} · ${formatUserPublicId(user.publicId)}`,
        `邮箱：${user.email}`,
        `轮询：${this.running ? '运行中' : '待命'} · 最近：${
          this.lastPollAt ? this.formatDateTime(this.lastPollAt) : '暂无'
        }`,
        this.lastError ? `错误：${this.lastError}` : '错误：无',
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
        [{ text: '刷新', callback_data: 'pv:status' }],
        [{ text: '返回', callback_data: 'pv:home' }],
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
        uploadedAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
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
                  `   ${this.publicLinkCopyLine(image, setting)}`,
              ),
            ].join('\n')
          : '最近图片\n\n暂无图片。',
      parseMode: 'HTML',
      keyboard: [
        ...this.imageViewRows(images),
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async linksPanel(
    ownerId: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): Promise<TelegramPanel> {
    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        status: ImageStatus.READY,
        visibility: { not: Visibility.PRIVATE },
        uploadedAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
        visibility: true,
        status: true,
      },
    });

    if (!images.length) {
      return {
        text: '链接格式\n\n暂无可公开访问的图片。把默认可见性设为公开或隐藏链接后，再发送图片上传。',
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }

    return this.linkFormatPanel(ownerId, setting, images[0].id, images);
  }

  private async linkFormatPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
    imageId: string,
    prefetchedImages?: Array<{
      id: string;
      title: string;
      originalName: string;
      mimeType: string;
      storageKey: string;
      storageProvider: StorageProvider;
      thumbKey: string | null;
      visibility: Visibility;
      status: ImageStatus;
    }>,
  ): Promise<TelegramPanel> {
    const image =
      prefetchedImages?.find((item) => item.id === imageId) ??
      (await this.prisma.image.findFirst({
        where: {
          id: imageId,
          ownerId,
          status: ImageStatus.READY,
          visibility: { not: Visibility.PRIVATE },
          uploadedAt: { not: null },
        },
        select: {
          id: true,
          title: true,
          originalName: true,
          mimeType: true,
          storageKey: true,
          storageProvider: true,
          thumbKey: true,
          visibility: true,
          status: true,
        },
      }));

    if (!image) {
      return {
        text: '链接格式\n\n这张图片暂时不能生成公开链接。',
        keyboard: [[{ text: '返回', callback_data: 'pv:links' }]],
      };
    }

    const title = image.title || image.originalName;
    const links = this.publicLinksForImage(image, setting);
    if (!links.imageUrl || !links.shareUrl) {
      return {
        text: [
          '链接格式',
          '',
          links.message ||
            '当前没有可用公网域名，请先在控制中心设置站点公开域名。',
        ].join('\n'),
        keyboard: [[{ text: '返回', callback_data: 'pv:links' }]],
      };
    }

    const markdown = `![${title}](${links.imageUrl})`;
    const nodeSeek = `![](${links.imageUrl})`;
    const html = `<img src="${links.imageUrl}" alt="${title}">`;
    const bbcode = `[img]${links.imageUrl}[/img]`;
    const recentRows =
      prefetchedImages
        ?.filter((item) => item.id !== image.id)
        .slice(0, 5)
        .map((item, index) => [
          {
            text: `换第 ${index + 2} 张：${this.truncateButtonText(
              item.title || item.originalName,
            )}`,
            callback_data: `pv:link:${item.id}`,
          },
        ]) ?? [];

    return {
      text: [
        '链接格式',
        '',
        this.escapeHtml(title),
        '',
        `直链： ${this.copyCode(links.imageUrl)}`,
        '',
        `Markdown： ${this.copyCode(markdown)}`,
        '',
        `NodeSeek： ${this.copyCode(nodeSeek)}`,
        '',
        `HTML： ${this.copyCode(html)}`,
        '',
        `BBCode： ${this.copyCode(bbcode)}`,
        '',
        `分享页： ${this.copyCode(links.shareUrl)}`,
      ].join('\n'),
      parseMode: 'HTML',
      keyboard: [
        [
          { text: '打开图片', url: links.imageUrl },
          { text: '分享页', url: links.shareUrl },
        ],
        [
          { text: '复制直链', copy_text: { text: links.imageUrl } },
          { text: '复制 MD', copy_text: { text: markdown } },
        ],
        [
          { text: '复制 HTML', copy_text: { text: html } },
          { text: '复制 BBCode', copy_text: { text: bbcode } },
        ],
        ...recentRows,
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
      previews: [this.previewForImage(ownerId, image, setting)].filter(
        (preview): preview is TelegramPreview => Boolean(preview),
      ),
    };
  }

  private async imagePanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
    imageId: string,
  ): Promise<TelegramPanel> {
    const image = await this.prisma.image.findFirst({
      where: {
        id: imageId,
        ownerId,
        uploadedAt: { not: null },
      },
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
        createdAt: true,
        album: {
          select: { name: true },
        },
      },
    });

    if (!image) {
      return {
        text: '图片详情\n\n图片不存在或无权访问。',
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }

    const title = image.title || image.originalName;
    const dimensions =
      image.width && image.height ? `${image.width}x${image.height}` : '未知';
    const links = this.publicLinksForImage(image, setting);

    return {
      text: [
        '图片详情',
        '',
        this.escapeHtml(title),
        `文件：${this.escapeHtml(image.originalName)}`,
        `状态：${this.statusText(image.status)} · ${this.visibilityText(
          image.visibility,
        )}`,
        `尺寸：${dimensions} · 大小：${this.formatBytes(
          Number(image.sizeBytes),
        )}`,
        `相册：${this.escapeHtml(image.album?.name ?? '未归档')}`,
        `上传：${this.formatDateTime(image.createdAt)}`,
        this.publicLinkCopyLine(image, setting),
        links.shareUrl ? `分享页： ${this.copyCode(links.shareUrl)}` : '',
        this.nodeSeekCopyLine(links.imageUrl),
      ]
        .filter(Boolean)
        .join('\n'),
      parseMode: 'HTML',
      keyboard: [
        ...(links.imageUrl && links.shareUrl
          ? [
              [
                { text: '打开图片', url: links.imageUrl },
                { text: '分享页', url: links.shareUrl },
              ],
            ]
          : []),
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
      previews: [this.previewForImage(ownerId, image, setting)].filter(
        (preview): preview is TelegramPreview => Boolean(preview),
      ),
    };
  }

  private imageViewRows(
    images: Array<{ id: string; title: string; originalName: string }>,
  ): InlineKeyboardButton[][] {
    return images.slice(0, 8).map((image, index) => [
      {
        text: `查看第 ${index + 1} 张：${this.truncateButtonText(
          image.title || image.originalName,
        )}`,
        callback_data: `pv:img:${image.id}`,
      },
    ]);
  }

  private async libraryPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
  ): Promise<TelegramPanel> {
    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        status: { not: ImageStatus.DELETED },
        uploadedAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
        createdAt: true,
        album: {
          select: { name: true },
        },
      },
    });

    return {
      text:
        images.length > 0
          ? '图片库\n\n选择下面的图片查看详情。'
          : '图片库\n\n暂无图片。',
      keyboard: [
        ...this.imageViewRows(images),
        [
          { text: '刷新', callback_data: 'pv:library' },
          {
            text: '打开图片库',
            url: new URL('/library', this.publicAppUrl(setting)).toString(),
          },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async searchPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
    query: string,
  ): Promise<TelegramPanel> {
    const keyword = query.trim();
    if (!keyword) {
      return {
        text: [
          '搜索',
          '',
          '发送 /search 关键词 搜索标题、文件名、描述和标签。',
          '也可以直接给 Bot 发送关键词。',
        ].join('\n'),
        keyboard: [
          [
            {
              text: '打开图片库',
              url: new URL('/library', this.publicAppUrl(setting)).toString(),
            },
          ],
          [{ text: '返回', callback_data: 'pv:home' }],
        ],
      };
    }

    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        status: { not: ImageStatus.DELETED },
        uploadedAt: { not: null },
        OR: [
          { title: { contains: keyword, mode: 'insensitive' } },
          { originalName: { contains: keyword, mode: 'insensitive' } },
          { description: { contains: keyword, mode: 'insensitive' } },
          { tags: { has: keyword } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
        album: {
          select: { name: true },
        },
      },
    });

    return {
      text:
        images.length > 0
          ? [
              `搜索：${keyword}`,
              '',
              ...images.map(
                (image, index) =>
                  `${index + 1}. ${image.title || image.originalName}\n` +
                  `   ${this.statusText(image.status)} · ${this.visibilityText(
                    image.visibility,
                  )} · ${this.formatBytes(Number(image.sizeBytes))}\n` +
                  `   相册：${image.album?.name ?? '未归档'}`,
              ),
            ].join('\n')
          : `搜索：${keyword}\n\n没有匹配图片。`,
      keyboard: [
        ...this.imageViewRows(images),
        [
          { text: '重新搜索', callback_data: 'pv:search' },
          {
            text: '打开图片库',
            url: new URL(
              `/library?q=${encodeURIComponent(keyword)}`,
              this.publicAppUrl(setting),
            ).toString(),
          },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async grabUrlPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
    rawUrl: string,
  ): Promise<TelegramPanel> {
    const url = rawUrl.trim();
    if (!url) {
      return {
        text: [
          '链接抓图',
          '',
          '发送图片 URL 可直接抓取上传。',
          '格式：/grab https://example.com/image.jpg',
        ].join('\n'),
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }

    try {
      new URL(url);
    } catch {
      return {
        text: '链接抓图\n\nURL 格式不正确，请发送 http 或 https 图片地址。',
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }

    try {
      const image = await this.upload.importUrl(ownerId, {
        url,
        albumId: setting.telegramAlbumId ?? undefined,
        visibility: setting.defaultVisibility,
      });
      const displayImage =
        (await this.waitForImage(ownerId, image.id, 5000)) ?? image;
      const links = this.publicLinksForImage(displayImage, setting);

      return {
        text: [
          '链接抓图完成',
          '',
          `文件：${this.escapeHtml(displayImage.originalName)}`,
          `大小：${this.formatBytes(Number(displayImage.sizeBytes))}`,
          `状态：${this.statusText(displayImage.status)}`,
          `可见性：${this.visibilityText(displayImage.visibility)}`,
          this.publicLinkCopyLine(displayImage, setting),
          links.shareUrl ? `分享页： ${this.copyCode(links.shareUrl)}` : '',
          this.nodeSeekCopyLine(links.imageUrl),
        ]
          .filter(Boolean)
          .join('\n'),
        parseMode: 'HTML',
        keyboard: [
          ...(links.imageUrl && links.shareUrl
            ? [
                [
                  { text: '打开图片', url: links.imageUrl },
                  { text: '分享页', url: links.shareUrl },
                ],
              ]
            : []),
          [
            { text: '继续抓图', callback_data: 'pv:grab' },
            { text: '返回', callback_data: 'pv:home' },
          ],
        ],
        previews: [this.previewForImage(ownerId, displayImage, setting)].filter(
          (preview): preview is TelegramPreview => Boolean(preview),
        ),
      };
    } catch (error) {
      return {
        text: [
          '链接抓图失败',
          '',
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }
  }

  private async integrationPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
    chatId: string,
  ): Promise<TelegramPanel> {
    const [albums, keys] = await Promise.all([
      this.prisma.album.count({ where: { ownerId } }),
      this.prisma.apiKey.count({ where: { userId: ownerId } }),
    ]);

    return {
      text: [
        '集成状态',
        '',
        `Telegram：${setting.telegramBotEnabled ? '已启用' : '未启用'} · ${
          setting.telegramBotToken ? '已连接 Token' : '未配置 Token'
        }`,
        `当前 Chat ID：${chatId}`,
        `Chat 白名单：${
          setting.telegramAllowedChatIds.length
            ? setting.telegramAllowedChatIds.join(', ')
            : '未限制'
        }`,
        `API 上传：${setting.apiUpload ? '开启' : '关闭'} · API 密钥 ${keys} 个`,
        `存储：${setting.storageProvider}`,
        `相册：${albums} 个`,
        `站点域名：${this.safePublicAppUrl(setting)}`,
        `图片域名：${this.safePublicImageBaseUrl(setting)}`,
      ].join('\n'),
      keyboard: [
        [{ text: '刷新', callback_data: 'pv:integrations' }],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async uploadLocationPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
  ): Promise<TelegramPanel> {
    const albums = await this.prisma.album.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: {
        _count: {
          select: { images: true },
        },
      },
    });
    const current = albums.find(
      (album) => album.id === setting.telegramAlbumId,
    );

    return {
      text: [
        '上传位置',
        '',
        `存储位置：${this.storageProviderText(setting)}`,
        `默认相册：${current?.name ?? '未绑定'}`,
        `默认可见性：${this.visibilityText(setting.defaultVisibility)}`,
        `单图上限：${this.formatBytes(setting.maxSizeBytes)}`,
        '',
        albums.length
          ? '点击下面的相册可设置为 Telegram 默认上传位置。'
          : '暂无相册，请先在网页端创建相册。',
      ].join('\n'),
      keyboard: [
        [
          {
            text: `${
              setting.storageProvider === StorageProvider.LOCAL ? '✓ ' : ''
            }本地存储`,
            callback_data: 'pv:storage:LOCAL',
          },
          {
            text: `${
              setting.storageProvider === StorageProvider.S3 ? '✓ ' : ''
            }S3 存储桶`,
            callback_data: 'pv:storage:S3',
          },
        ],
        ...albums.slice(0, 6).map((album) => [
          {
            text: `设为上传位置：${this.truncateButtonText(album.name)}`,
            callback_data: `pv:album:${album.id}`,
          },
        ]),
        [
          { text: '不绑定相册', callback_data: 'pv:album:none' },
          { text: '设为公开', callback_data: 'pv:vis:PUBLIC' },
        ],
        [{ text: '隐藏链接', callback_data: 'pv:vis:UNLISTED' }],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async apiKeysPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
  ): Promise<TelegramPanel> {
    const [keys, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where: { userId: ownerId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          name: true,
          lastUsedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.apiKey.count({ where: { userId: ownerId } }),
    ]);

    return {
      text: [
        'API 密钥',
        '',
        `API 上传：${setting.apiUpload ? '开启' : '关闭'}`,
        `密钥数量：${total}`,
        '',
        keys.length
          ? keys
              .map(
                (key, index) =>
                  `${index + 1}. ${key.name}\n` +
                  `   创建：${this.formatDateTime(key.createdAt)}\n` +
                  `   最近使用：${
                    key.lastUsedAt
                      ? this.formatDateTime(key.lastUsedAt)
                      : '从未'
                  }`,
              )
              .join('\n')
          : '暂无 API 密钥。',
      ].join('\n'),
      keyboard: [
        [
          { text: '刷新', callback_data: 'pv:keys' },
          {
            text: '打开设置',
            url: new URL('/settings', this.publicAppUrl(setting)).toString(),
          },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async trashPanel(
    ownerId: string,
    setting: TelegramRuntimeSetting,
  ): Promise<TelegramPanel> {
    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        status: ImageStatus.DELETED,
        uploadedAt: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        visibility: true,
        status: true,
        storageKey: true,
        storageProvider: true,
        thumbKey: true,
        updatedAt: true,
      },
    });

    return {
      text:
        images.length > 0
          ? [
              '回收站',
              '',
              ...images.map(
                (image, index) =>
                  `${index + 1}. ${image.title || image.originalName}\n` +
                  `   ${this.formatBytes(Number(image.sizeBytes))} · 删除于 ${this.formatDateTime(
                    image.updatedAt,
                  )}`,
              ),
            ].join('\n')
          : '回收站\n\n暂无已删除图片。',
      keyboard: [
        ...this.imageViewRows(images),
        [
          { text: '刷新', callback_data: 'pv:trash' },
          {
            text: '打开回收站',
            url: new URL('/trash', this.publicAppUrl(setting)).toString(),
          },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private async albumsPanel(
    ownerId: string,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): Promise<TelegramPanel> {
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
    const current = albums.find(
      (album) => album.id === setting.telegramAlbumId,
    );

    return {
      text:
        albums.length > 0
          ? [
              '相册',
              '',
              `当前上传位置：${current?.name ?? '未绑定'}`,
              '',
              ...albums.map(
                (album, index) =>
                  `${index + 1}. ${album.name}${
                    album.id === setting.telegramAlbumId
                      ? ' · 当前上传位置'
                      : ''
                  } · ${album._count.images} 张 · ${this.visibilityText(
                    album.visibility,
                  )}`,
              ),
            ].join('\n')
          : '相册\n\n暂无相册。',
      keyboard: [
        ...albums.slice(0, 8).map((album) => [
          {
            text: `设为上传位置：${this.truncateButtonText(album.name)}`,
            callback_data: `pv:album:${album.id}`,
          },
        ]),
        [{ text: '不绑定相册', callback_data: 'pv:album:none' }],
        [
          {
            text: '打开相册页',
            url: new URL('/albums', this.publicAppUrl(setting)).toString(),
          },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
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
        `站点域名：${this.safePublicAppUrl(setting)}`,
        `图片域名：${this.safePublicImageBaseUrl(setting)}`,
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
        [{ text: '设为隐藏链接', callback_data: 'pv:vis:UNLISTED' }],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private uploadGuidePanel(
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): TelegramPanel {
    return {
      text: [
        '上传说明',
        '',
        '直接发送图片或图片文件即可上传到 PicVault。',
        `默认可见性：${this.visibilityText(setting.defaultVisibility)}`,
        `单图上限：${this.formatBytes(setting.maxSizeBytes)}`,
        `允许类型：${setting.allowedTypes.join(', ') || 'image/*'}`,
        `默认相册：${setting.telegramAlbumId ? '已绑定' : '未绑定'}`,
      ].join('\n'),
      keyboard: [
        [
          { text: '设为公开', callback_data: 'pv:vis:PUBLIC' },
          { text: '设为隐藏链接', callback_data: 'pv:vis:UNLISTED' },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private sitePanel(
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ): TelegramPanel {
    let appUrl: string;
    let imageBaseUrl: string;
    try {
      appUrl = this.publicAppUrl(setting);
      imageBaseUrl = this.publicImageBaseUrl(setting);
    } catch (error) {
      return {
        text: [
          '站点入口',
          '',
          error instanceof Error ? error.message : String(error),
          '请到控制中心填写站点公开域名 / Telegram 外链域名。',
        ].join('\n'),
        keyboard: [[{ text: '返回', callback_data: 'pv:home' }]],
      };
    }
    return {
      text: [
        '站点入口',
        '',
        `控制台：${appUrl}`,
        `上传页：${new URL('/upload', appUrl).toString()}`,
        `图片库：${new URL('/library', appUrl).toString()}`,
        `图片域名：${imageBaseUrl}`,
      ].join('\n'),
      keyboard: [
        [
          { text: '打开控制台', url: appUrl },
          { text: '上传页', url: new URL('/upload', appUrl).toString() },
        ],
        [{ text: '返回', callback_data: 'pv:home' }],
      ],
    };
  }

  private helpPanel(
    prefix?: string,
    setting?: TelegramUrlSetting,
  ): TelegramPanel {
    return {
      text: [
        prefix,
        'PicVault Telegram 控制台',
        '',
        '发送图片：直接上传到 PicVault',
        '发送链接：抓取远程图片',
        '发送关键词：搜索图片库',
        '/panel：打开控制台',
        '/console：实时文字台',
        '/library：图片库和图片预览',
        '/search 关键词：搜索图片',
        '/grab URL：链接抓图',
        '/status：查看状态和容量',
        '/integrations：查看集成状态',
        '/recent：查看最近图片',
        '/links：复制最近公开图片链接格式',
        '/albums：查看相册',
        '/location：设置 Telegram 上传位置',
        '/keys：查看 API 密钥',
        '/trash：查看回收站',
        '/upload：查看上传说明',
        '/policy：查看上传策略',
        '/public /private /unlisted：切换默认可见性',
        '/site：查看站点入口',
        setting ? `当前站点：${this.safePublicAppUrl(setting)}` : '',
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

  private async updateTelegramAlbum(
    ownerId: string,
    albumId: string,
  ): Promise<TelegramPanel> {
    if (albumId === 'none') {
      await this.settings.update(ownerId, { telegramAlbumId: null });
      return this.uploadLocationPanel(
        ownerId,
        await this.settings.getRuntime(ownerId),
      );
    }

    const album = await this.prisma.album.findFirst({
      where: { id: albumId, ownerId },
      select: { id: true },
    });
    if (!album) {
      return {
        text: '上传位置\n\n相册不存在或无权访问。',
        keyboard: [[{ text: '返回', callback_data: 'pv:location' }]],
      };
    }

    await this.settings.update(ownerId, { telegramAlbumId: album.id });
    return this.uploadLocationPanel(
      ownerId,
      await this.settings.getRuntime(ownerId),
    );
  }

  private async updateStorageProvider(
    ownerId: string,
    provider: string,
  ): Promise<TelegramPanel> {
    if (!Object.values(StorageProvider).includes(provider as StorageProvider)) {
      return {
        text: '上传位置\n\n存储位置无效。',
        keyboard: [[{ text: '返回', callback_data: 'pv:location' }]],
      };
    }

    await this.settings.update(ownerId, {
      storageProvider: provider as StorageProvider,
    });
    return this.uploadLocationPanel(
      ownerId,
      await this.settings.getRuntime(ownerId),
    );
  }

  private async imageStats(ownerId: string) {
    const [total, ready, pending, failed, deleted, user] =
      await this.prisma.$transaction([
        this.prisma.image.count({
          where: {
            ownerId,
            status: { not: ImageStatus.DELETED },
            uploadedAt: { not: null },
          },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: ImageStatus.READY,
            uploadedAt: { not: null },
          },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: { in: [ImageStatus.PENDING, ImageStatus.PROCESSING] },
            uploadedAt: { not: null },
          },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: ImageStatus.FAILED,
            uploadedAt: { not: null },
          },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: ImageStatus.DELETED,
            uploadedAt: { not: null },
          },
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
        { text: '状态中心', callback_data: 'pv:status' },
        { text: '图片库', callback_data: 'pv:library' },
      ],
      [
        { text: '搜索图片', callback_data: 'pv:search' },
        { text: '链接抓图', callback_data: 'pv:grab' },
      ],
      [
        { text: '上传位置', callback_data: 'pv:location' },
        { text: '相册', callback_data: 'pv:albums' },
      ],
      [
        { text: 'API 密钥', callback_data: 'pv:keys' },
        { text: '回收站', callback_data: 'pv:trash' },
      ],
      [
        { text: '集成状态', callback_data: 'pv:integrations' },
        { text: '链接格式', callback_data: 'pv:links' },
      ],
      [
        { text: '刷新', callback_data: 'pv:refresh' },
        { text: '站点入口', callback_data: 'pv:site' },
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
      parse_mode: panel.parseMode,
      reply_markup: panel.keyboard
        ? {
            inline_keyboard: panel.keyboard,
          }
        : undefined,
    });
    await this.sendPreviews(token, chatId, panel.previews);
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
        parse_mode: panel.parseMode,
        reply_markup: panel.keyboard
          ? {
              inline_keyboard: panel.keyboard,
            }
          : undefined,
      });
    } catch {
      await this.sendPanel(token, chatId, panel);
      return;
    }

    await this.sendPreviews(token, chatId, panel.previews);
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

  private async sendPreviews(
    token: string,
    chatId: string,
    previews?: TelegramPreview[],
  ) {
    if (!previews?.length) {
      return;
    }

    for (const preview of previews.slice(0, 4)) {
      try {
        await this.sendPreview(token, chatId, preview);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Telegram preview failed: ${message}`);
      }
    }
  }

  private async sendPreview(
    token: string,
    chatId: string,
    preview: TelegramPreview,
  ) {
    const caption = [
      preview.title,
      preview.shareUrl ? `分享页：${preview.shareUrl}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1024);
    const replyMarkup = preview.shareUrl
      ? {
          inline_keyboard: [[{ text: '分享页', url: preview.shareUrl }]],
        }
      : undefined;

    if (preview.imageUrl) {
      try {
        await this.telegram(token, 'sendPhoto', {
          chat_id: chatId,
          photo: preview.imageUrl,
          caption,
          reply_markup: replyMarkup,
        });
        return;
      } catch {
        // Fall back to uploading the stored object when Telegram cannot fetch
        // the public URL, which also covers old/internal stored links.
      }
    }

    const setting = await this.settings.getRuntime(preview.ownerId);
    const buffer = await this.storage.getObjectBuffer(preview.storageKey, {
      ...setting,
      storageProvider: preview.storageProvider,
    });
    if (!buffer.length) {
      return;
    }

    const sendAsPhoto =
      buffer.length <= 9 * 1024 * 1024 && preview.contentType !== 'image/gif';
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }

    const filename =
      preview.storageKey.split('/').pop() ||
      `preview.${this.extensionForContentType(preview.contentType)}`;
    const blob = new Blob([buffer], { type: preview.contentType });
    if (sendAsPhoto) {
      form.append('photo', blob, filename);
      await this.telegramMultipart(token, 'sendPhoto', form);
    } else {
      form.append('document', blob, filename);
      await this.telegramMultipart(token, 'sendDocument', form);
    }
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

  private async telegramMultipart<T = unknown>(
    token: string,
    method: string,
    body: FormData,
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(30000),
      },
    );

    const data = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }

    return data.result;
  }

  private shareUrl(imageId: string, setting?: TelegramUrlSetting) {
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
      id?: string;
      storageKey: string;
      storageProvider: StorageProvider;
      visibility: Visibility;
      status: ImageStatus;
    },
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (this.isPublicReadyImage(image)) {
      const links = this.publicLinksForImage(image, setting);
      return links.imageUrl
        ? `链接：${links.imageUrl}`
        : `链接：${links.message}`;
    }

    if (image.visibility === Visibility.PRIVATE) {
      return '链接：私有图片不生成公开链接';
    }

    return '链接：图片处理完成后可访问';
  }

  private publicLinkCopyLine(
    image: {
      id?: string;
      storageKey: string;
      storageProvider: StorageProvider;
      visibility: Visibility;
      status: ImageStatus;
    },
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (this.isPublicReadyImage(image)) {
      const links = this.publicLinksForImage(image, setting);
      return links.imageUrl
        ? `链接： ${this.copyCode(links.imageUrl)}`
        : `链接：${this.escapeHtml(links.message ?? '暂无可用链接')}`;
    }

    if (image.visibility === Visibility.PRIVATE) {
      return '链接：私有图片不生成公开链接';
    }

    return '链接：图片处理完成后可访问';
  }

  private nodeSeekCopyLine(imageUrl?: string) {
    return imageUrl ? `NodeSeek： ${this.copyCode(`![](${imageUrl})`)}` : '';
  }

  private copyCode(value: string) {
    return `<code>${this.escapeHtml(value)}</code>`;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private publicLinksForImage(
    image: {
      id?: string;
      storageKey: string;
      storageProvider: StorageProvider;
      visibility: Visibility;
      status: ImageStatus;
    },
    setting?: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (!this.isPublicReadyImage(image)) {
      return {
        imageUrl: '',
        shareUrl: '',
        message:
          image.visibility === Visibility.PRIVATE
            ? '私有图片不生成公开链接'
            : '图片处理完成后可访问',
      };
    }

    try {
      return {
        imageUrl: this.imagePublicUrl(image, setting),
        shareUrl: image.id ? this.shareUrl(image.id, setting) : '',
      };
    } catch (error) {
      return {
        imageUrl: '',
        shareUrl: '',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private previewForImage(
    ownerId: string,
    image: {
      id?: string;
      title: string;
      originalName: string;
      mimeType: string;
      storageKey: string;
      storageProvider: StorageProvider;
      thumbKey?: string | null;
      visibility: Visibility;
      status: ImageStatus;
    },
    setting?: TelegramRuntimeSetting,
  ): TelegramPreview | null {
    const key = image.thumbKey || image.storageKey;
    const contentType = image.thumbKey ? 'image/webp' : image.mimeType;
    const links = this.publicLinksForImage(image, setting);

    return {
      ownerId,
      title: image.title || image.originalName,
      storageKey: key,
      storageProvider: image.storageProvider,
      contentType,
      imageUrl: links.imageUrl || undefined,
      shareUrl: links.shareUrl || undefined,
    };
  }

  private async waitForImage(
    ownerId: string,
    imageId: string,
    timeoutMs: number,
  ) {
    const startedAt = Date.now();
    let lastImage: {
      id: string;
      title: string;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint | number;
      visibility: Visibility;
      status: ImageStatus;
      storageKey: string;
      storageProvider: StorageProvider;
      thumbKey: string | null;
    } | null = null;

    do {
      const image = await this.prisma.image.findFirst({
        where: { id: imageId, ownerId },
        select: {
          id: true,
          title: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          visibility: true,
          status: true,
          storageKey: true,
          storageProvider: true,
          thumbKey: true,
        },
      });

      if (!image) {
        return lastImage;
      }
      lastImage = image;
      if (
        image.status === ImageStatus.READY ||
        image.status === ImageStatus.FAILED ||
        image.status === ImageStatus.PENDING
      ) {
        return image;
      }

      await this.delay(500);
    } while (Date.now() - startedAt < timeoutMs);

    return lastImage;
  }

  private imagePublicUrl(
    image: { storageKey: string; storageProvider: StorageProvider },
    setting?: TelegramUrlSetting,
  ) {
    const base = this.publicImageBaseUrl({
      ...setting,
      storageProvider: image.storageProvider,
    });
    return `${base.replace(/\/$/, '')}/${image.storageKey}`;
  }

  private publicAppUrl(setting?: TelegramUrlSetting) {
    return this.firstPublicBaseUrl([
      { value: setting?.appPublicUrl },
      { value: this.config.get<string>('APP_PUBLIC_URL') },
      { value: setting?.publicBaseUrl },
      { value: this.config.get<string>('PUBLIC_IMAGE_BASE_URL') },
    ]);
  }

  private safePublicAppUrl(setting?: TelegramUrlSetting) {
    try {
      return this.publicAppUrl(setting);
    } catch {
      return '未配置公网域名';
    }
  }

  private publicImageBaseUrl(setting?: TelegramUrlSetting) {
    const appPublicUrl =
      setting?.appPublicUrl?.trim() ||
      this.config.get<string>('APP_PUBLIC_URL')?.trim();

    return this.firstPublicBaseUrl(
      [
        {
          value: setting?.publicBaseUrl,
          fallbackPath: '/api/public/files',
          relativeBaseUrl: appPublicUrl,
        },
        {
          value: this.config.get<string>('PUBLIC_IMAGE_BASE_URL'),
          fallbackPath: '/api/public/files',
          relativeBaseUrl: appPublicUrl,
        },
        {
          value: '/api/public/files',
          relativeBaseUrl: appPublicUrl,
        },
      ],
      '/api/public/files',
    );
  }

  private safePublicImageBaseUrl(setting?: TelegramUrlSetting) {
    try {
      return this.publicImageBaseUrl(setting);
    } catch {
      return '未配置公网域名';
    }
  }

  private normalizePublicBaseUrl(
    value?: string | null,
    fallbackPath = '',
    relativeBaseUrl?: string | null,
  ) {
    const raw = value?.trim();
    if (!raw) {
      throw new Error(
        'Telegram 需要公网访问域名：请在控制中心设置站点公开域名或图片公开域名',
      );
    }

    if (raw.startsWith('/')) {
      const appUrl =
        relativeBaseUrl?.trim() ||
        this.config.get<string>('APP_PUBLIC_URL')?.trim() ||
        this.config.get<string>('PUBLIC_IMAGE_BASE_URL')?.trim();
      if (!appUrl || appUrl.startsWith('/')) {
        throw new Error(
          'Telegram 需要公网访问域名：当前图片域名是相对路径，请在控制中心设置反代后的公开域名',
        );
      }

      return `${this.normalizePublicBaseUrl(appUrl)}${raw}`;
    }

    const parsed = new URL(raw);
    if (this.isPrivateHost(parsed.hostname)) {
      throw new Error(
        `Telegram 不能使用内网地址 ${parsed.host}，请配置反代后的公网域名`,
      );
    }

    if (fallbackPath && !parsed.pathname.replace(/\/$/, '')) {
      parsed.pathname = fallbackPath;
    }

    return parsed.toString().replace(/\/$/, '');
  }

  private firstPublicBaseUrl(
    candidates: Array<{
      value?: string | null;
      fallbackPath?: string;
      relativeBaseUrl?: string | null;
    }>,
    fallbackPath = '',
  ) {
    let lastError: unknown;
    for (const candidate of candidates) {
      if (!candidate.value?.trim()) {
        continue;
      }

      try {
        return this.normalizePublicBaseUrl(
          candidate.value,
          candidate.fallbackPath ?? fallbackPath,
          candidate.relativeBaseUrl,
        );
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(
      'Telegram 需要公网访问域名：请在控制中心设置站点公开域名或图片公开域名',
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

  private formatDateTime(value: Date) {
    return value.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
  }

  private extensionForContentType(contentType: string) {
    return (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/avif': 'avif',
      }[contentType] ?? 'jpg'
    );
  }

  private truncateButtonText(value: string, maxLength = 24) {
    const normalized = value.trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 1)}…`
      : normalized;
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  private storageProviderText(setting: TelegramRuntimeSetting) {
    if (setting.storageProvider === StorageProvider.S3) {
      return `S3 存储桶${setting.s3Bucket ? `：${setting.s3Bucket}` : '（未配置桶名）'}`;
    }

    return '本地存储';
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

  private isPrivateHost(hostname: string) {
    const normalized = hostname.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) {
      return this.isPrivateHost(mappedIpv4);
    }

    if (normalized.startsWith('::ffff:')) {
      return true;
    }

    if (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '0.0.0.0' ||
      normalized === '::1' ||
      normalized === '::' ||
      normalized.endsWith('.local')
    ) {
      return true;
    }

    if (normalized.includes(':')) {
      return (
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8:')
      );
    }

    const parts = normalized.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return false;
    }

    const [first, second] = parts;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
}
