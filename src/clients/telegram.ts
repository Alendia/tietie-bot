import type Context from 'telegraf/typings/context';
import type { Message, Update, User } from 'telegraf/typings/core/types/typegram'

import { EventEmitter } from 'events';
import { Telegraf } from 'telegraf';

import { GenericClient, GenericMessage, MessageToEdit, MessageToSend } from './base';
import config from '../../config.json';
import { createShortUrl } from 'src/database/shorturl';
import { setTelegramFileId } from 'src/database/tgfile';

export const fileIdToUrl = async (fileId: string, fileUniqueId: string | null, mimeType: string) => {
  const serverRoot = /^https?:/.test(config.serverRoot) ? config.serverRoot : 'https://' + config.serverRoot;
  if (fileUniqueId) {
    try {
      await setTelegramFileId(fileUniqueId, fileId);
      return `${serverRoot}/tguniq/${mimeType}/${fileUniqueId}`;
    } catch (e) {
      console.warn('[TelegramBotClient] fileIdToUrl error', e);
    }
  }
  return `${serverRoot}/tgfile/${mimeType}/${fileId}`;
};

export class TelegramBotClient extends EventEmitter implements GenericClient<Message, User, any> {
  public bot: Telegraf<Context<Update>> = new Telegraf(config.telegramBotToken);

  public constructor() {
    super();
    this.bot.on('message', async (ctx: Context<Update.MessageUpdate>) => {
      if (!ctx.message || ctx.message.date * 1000 < Date.now() - 10000) return;
      const transformedMessage = await this.transformMessage(ctx.message);
      if (!transformedMessage) return;
      this.emit('message', transformedMessage);
    });
    this.bot.on('edited_message', async (ctx: Context<Update.EditedMessageUpdate>) => {
      const transformedMessage = await this.transformMessage(ctx.editedMessage!);
      if (!transformedMessage) return;
      this.emit('edit-message', transformedMessage);
    });
  }

  public async start(): Promise<void> {
    this.bot.launch();
  }

  public async stop(): Promise<void> {
    this.bot.stop();
  }

  public async sendMessage(message: MessageToSend): Promise<GenericMessage<Message, User>> {
    const method = ({
      sticker: 'sendSticker',
      photo: 'sendPhoto',
      video: 'sendVideo',
      file: 'sendDocument',
      default: 'sendMessage',
    } as const)[message.media?.type ?? 'default'] ?? 'sendMessage';

    const content = message.media?.url ?? message.text;
    const options = {
      reply_to_message_id: message.messageIdReplied ? Number(message.messageIdReplied) : undefined,
      caption: message.media ? message.text : undefined,
      ...message.rawMessageExtra ?? {},
    };
    const messageSent = await this.bot.telegram[method](message.chatId, content, options);
    return (await this.transformMessage(messageSent))!;
  }

  public async editMessage(message: MessageToEdit): Promise<void> {
    if (!message.media) {
      await this.bot.telegram.editMessageText(message.chatId, Number(message.messageId), undefined, message.text);
      return;
    }
    if (message.media.type === 'sticker') {
      return;
    }
    await this.bot.telegram.editMessageMedia(message.chatId, Number(message.messageId), undefined, {
      type: message.media.type === 'file' ? 'document' : message.media.type,
      media: message.media.url!,
      caption: message.text,
    });
  }

  public async setCommandList(commandList: { command: string; description: string; }[]): Promise<void> {
    await this.bot.telegram.setMyCommands(commandList);
  }

  public async transformMessage(message: Message): Promise<GenericMessage<Message, User> | undefined> {
    const text = 'text' in message && message.text || 'caption' in message && message.caption || '';
    const result: GenericMessage<Message, User> = {
      clientName: 'telegram',
      text,
      userId: String(message.from!.id),
      userName: this.transformUser(message.from),
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      messageIdReplied: 'reply_to_message' in message && String(message.reply_to_message?.message_id ?? '') || undefined,
      userIdReplied: 'reply_to_message' in message && String(message.reply_to_message?.from?.id ?? '') || undefined,
      rawMessage: message,
      rawUser: message.from!,
      rawMessageReplied: 'reply_to_message' in message && message.reply_to_message || undefined,
      unixDate: message.date,
    };
    if ('forward_origin' in message || 'forward_from' in message) {
      result.text = `[转发自 ${this.transformForwardOrigin(message)}] ${result.text}`;
    }
    const sticker = 'sticker' in message ? message.sticker : undefined;
    const photo = 'photo' in message ? message.photo.slice(-1)[0] : undefined;
    const video = 'video' in message ? message.video : undefined;
    const audio = 'audio' in message ? message.audio : undefined;
    const file = 'document' in message ? message.document : undefined;
    const fileId = (video ?? photo ?? audio ?? sticker ?? file)?.file_id;
    const fileUniqueId = (video ?? photo ?? audio ?? sticker ?? file)?.file_unique_id;

    if (!fileId) {
      return result;
    }
    if (sticker) {
      result.text = `[${sticker.emoji ?? '🖼️'} 贴纸] ${result.text}`;
      result.media = {
        type: 'sticker',
        mimeType: sticker?.is_video ? 'video/webm' : sticker?.is_animated ? 'application/tgs+gzip' : 'image/jpeg',
        size: sticker.file_size ?? 0,
        url: '',
        width: sticker.width,
        height: sticker.height,
      };
      result.media.url = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.media?.mimeType));
    } else if (video) {
      result.media = {
        type: 'video',
        mimeType: video.mime_type ?? 'video/mp4',
        size: video.file_size ?? 0,
        url: '',
        width: video.width,
        height: video.height,
      };
      result.media.url = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.media?.mimeType));
    } else if (photo) {
      const mediaUrl = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, 'image/jpeg'));
      if ('has_media_spoiler' in message && message.has_media_spoiler) {
        result.text = `[带有内容警告的媒体] ${mediaUrl} ${result.text}`.trim();
      } else {
        result.media = {
          type: 'photo',
          mimeType: 'image/jpeg',
          size: photo.file_size ?? 0,
          url: mediaUrl,
          width: photo.width,
          height: photo.height,
        };
      }
    } else {
      result.media = {
        type: 'file',
        mimeType: (file ?? audio)?.mime_type ?? 'application/octet-stream',
        size: (file ?? audio)?.file_size ?? 0,
        url: '',
      };
      result.media.url = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.media.mimeType));
    }
    return result;
  }

  private transformUser(user?: User): string {
    return user?.username ?? ((user?.first_name ?? '') + ' ' + (user?.last_name ?? '')).trim();
  }

  /**
   * Oh my god Durov see what you've done
   */
  private transformForwardOrigin(message: any) {
    const o = message.forward_origin;
    const originName = o?.sender_user_name || o?.sender_chat?.title || o?.chat?.title || message.forward_sender_name;
    const originChat = o?.sender_user || o?.chat || o?.sender_chat || message.forward_from;
    return originName || this.transformUser(originChat) || '未知会话';
  }
}

export default new TelegramBotClient();
