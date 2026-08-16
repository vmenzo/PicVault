import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { sendSmtpMail } from './smtp-client';

const SECRET_MASK = '********';

export type MailSettings = {
  smtpEnabled?: boolean | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  smtpFrom?: string | null;
};

type EffectiveMailSettings = {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpFrom: string;
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPasswordReset(input: {
    to: string;
    name: string;
    resetUrl: string;
    expiresMinutes: number;
  }) {
    const settings = await this.getEffectiveSettings();
    if (!settings) {
      this.logger.warn(
        `Password reset requested for ${input.to}, but SMTP is not configured`,
      );
      return false;
    }

    await this.send(settings, {
      to: input.to,
      subject: 'PicVault 密码重置',
      text: [
        `${input.name}，你好：`,
        '',
        '你正在重置 PicVault 账户密码。',
        `请在 ${input.expiresMinutes} 分钟内打开下面的链接设置新密码：`,
        input.resetUrl,
        '',
        '如果不是你本人操作，请忽略这封邮件。',
      ].join('\n'),
      html: [
        '<p>你好：</p>',
        '<p>你正在重置 PicVault 账户密码。</p>',
        `<p>请在 ${input.expiresMinutes} 分钟内打开下面的链接设置新密码：</p>`,
        `<p><a href="${this.escape(input.resetUrl)}">重置密码</a></p>`,
        `<p style="word-break:break-all;color:#64748b">${this.escape(input.resetUrl)}</p>`,
        '<p>如果不是你本人操作，请忽略这封邮件。</p>',
      ].join(''),
    });

    return true;
  }

  async sendRegistrationCode(input: {
    to: string;
    code: string;
    expiresMinutes: number;
  }) {
    const settings = await this.getEffectiveSettings();
    if (!settings) {
      throw new BadRequestException('SMTP is not configured');
    }

    await this.send(settings, {
      to: input.to,
      subject: 'PicVault 注册验证码',
      text: [
        '你好：',
        '',
        '你正在注册 PicVault 账户。',
        `验证码：${input.code}`,
        `验证码 ${input.expiresMinutes} 分钟内有效。`,
        '',
        '如果不是你本人操作，请忽略这封邮件。',
      ].join('\n'),
      html: [
        '<p>你好：</p>',
        '<p>你正在注册 PicVault 账户。</p>',
        `<p>验证码：<strong style="font-size:20px;letter-spacing:2px">${this.escape(input.code)}</strong></p>`,
        `<p>验证码 ${input.expiresMinutes} 分钟内有效。</p>`,
        '<p>如果不是你本人操作，请忽略这封邮件。</p>',
      ].join(''),
    });

    return true;
  }

  async sendTest(to: string) {
    const settings = await this.getEffectiveSettings();
    if (!settings) {
      throw new BadRequestException('SMTP is not configured');
    }

    await this.send(settings, {
      to,
      subject: 'PicVault 测试邮件',
      text: '如果你收到这封邮件，说明 PicVault 邮件发送配置可用。',
      html: '<p>如果你收到这封邮件，说明 PicVault 邮件发送配置可用。</p>',
    });

    return { ok: true };
  }

  isConfigured(settings: MailSettings) {
    return Boolean(
      settings.smtpEnabled &&
      settings.smtpHost &&
      settings.smtpPort &&
      settings.smtpFrom,
    );
  }

  async getEffectiveSettings(): Promise<EffectiveMailSettings | null> {
    const setting = await this.prisma.appSetting.findFirst({
      where: {
        owner: {
          role: 'ADMIN',
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        smtpEnabled: true,
        smtpHost: true,
        smtpPort: true,
        smtpSecure: true,
        smtpUsername: true,
        smtpPassword: true,
        smtpFrom: true,
      },
    });
    const configuredPort = Number(this.config.get<string>('SMTP_PORT') ?? 0);
    const settings = {
      smtpEnabled:
        setting?.smtpEnabled ??
        (this.config.get<string>('SMTP_ENABLED') ?? 'false') === 'true',
      smtpHost: setting?.smtpHost ?? this.config.get<string>('SMTP_HOST'),
      smtpPort:
        setting?.smtpPort ??
        (configuredPort > 0 ? configuredPort : undefined) ??
        undefined,
      smtpSecure:
        setting?.smtpSecure ??
        (this.config.get<string>('SMTP_SECURE') ?? 'true') === 'true',
      smtpUsername:
        this.unmask(setting?.smtpUsername) ??
        this.config.get<string>('SMTP_USERNAME'),
      smtpPassword:
        this.unmask(setting?.smtpPassword) ??
        this.config.get<string>('SMTP_PASSWORD'),
      smtpFrom: setting?.smtpFrom ?? this.config.get<string>('SMTP_FROM'),
    };

    if (
      !settings.smtpEnabled ||
      !settings.smtpHost ||
      !settings.smtpPort ||
      !settings.smtpFrom
    ) {
      return null;
    }

    return {
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      smtpUsername: settings.smtpUsername,
      smtpPassword: settings.smtpPassword,
      smtpFrom: settings.smtpFrom,
    };
  }

  async isRegistrationVerificationRequired() {
    return (await this.getEffectiveSettings()) !== null;
  }

  private async send(
    settings: EffectiveMailSettings,
    message: {
      to: string;
      subject: string;
      text: string;
      html: string;
    },
  ) {
    try {
      await sendSmtpMail({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        username: this.unmask(settings.smtpUsername),
        password: this.unmask(settings.smtpPassword),
        from: settings.smtpFrom,
        ...message,
      });
    } catch (error) {
      this.logger.error(
        `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('SMTP send failed');
    }
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[char];
    });
  }

  private unmask(value?: string | null) {
    if (!value || value === SECRET_MASK) return undefined;
    return value;
  }
}
