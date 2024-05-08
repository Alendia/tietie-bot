import type Context from 'telegraf/typings/context';
import type { Message, Sticker, Update, User } from 'telegraf/typings/core/types/typegram'

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
      this.emit('message', transformedMessage, ctx);
    });
    this.bot.on('edited_message', async (ctx: Context<Update.EditedMessageUpdate>) => {
      const transformedMessage = await this.transformMessage(ctx.editedMessage!);
      if (!transformedMessage) return;
      this.emit('edit-message', transformedMessage, ctx);
    });
  }

  public async start(): Promise<void> {
    await this.bot.launch();
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
    } as const)[message.mediaType ?? 'default'] ?? 'sendMessage';

    const content = message.mediaUrl ?? message.text;
    const options = {
      reply_to_message_id: message.messageIdReplied ? Number(message.messageIdReplied) : undefined,
      caption: message.mediaType ? message.text : undefined,
      ...message.rawMessageExtra ?? {},
    };
    console.log('[TelegramBotClient] sending message:', method, { content, ...options });
    const messageSent = await this.bot.telegram[method](message.chatId, content, options);
    return (await this.transformMessage(messageSent))!;
  }

  public async editMessage(message: MessageToEdit): Promise<void> {
    const newText = message.hideEditedFlag ? message.text : `${message.text} (已编辑)`;
    if (!message.mediaType) {
      await this.bot.telegram.editMessageText(message.chatId, Number(message.messageId), undefined, newText);
      return;
    }
    if (message.mediaType === 'sticker') {
      return;
    }
    await this.bot.telegram.editMessageMedia(message.chatId, Number(message.messageId), undefined, {
      type: message.mediaType === 'file' ? 'document' : message.mediaType,
      media: message.mediaUrl!,
      caption: newText,
    });
  }

  public async setCommandList(commandList: { command: string; description: string; }[]): Promise<void> {
    await this.bot.telegram.setMyCommands(commandList);
  }

  private async transformMessage(message: Message): Promise<GenericMessage<Message, User> | undefined> {
    const text = 'text' in message && message.text || 'caption' in message && message.caption || '';

    // filter out messages mentioning other bots
    if (/@(\w+bot)\b/.test(text) && RegExp.$1 !== this.bot.botInfo?.username) {
      return;
    }
    const result: GenericMessage<Message, User> = {
      clientName: 'telegram',
      text: text.replace(/@\w+/, ''),
      userId: String(message.from!.id),
      userName: this.transformUser(message.from),
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      messageIdReplied: 'reply_to_message' in message && String(message.reply_to_message?.message_id ?? '') || undefined,
      rawMessage: message,
      rawUser: message.from!,
      rawMessageReplied: 'reply_to_message' in message && message.reply_to_message || undefined,
      unixDate: message.date,
    };
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
      result.text = `[${sticker.emoji ?? '🖼️'} 贴纸] `;
      result.mediaType = 'sticker';
      result.mediaMimeType = sticker?.is_video ? 'video/webm' : sticker?.is_animated ? 'text/json' : 'image/jpeg';
      result.mediaSize = sticker.file_size;
      result.mediaUrl = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.mediaMimeType));
    } else if (video) {
      result.text = '[影片] ' + result.text;
      result.mediaType = 'video';
      result.mediaMimeType = video.mime_type ?? 'video/mp4';
      result.mediaSize = video.file_size;
      result.mediaUrl = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.mediaMimeType));
    } else if (photo) {
      result.text = '[图片] ' + result.text;
      result.mediaType = 'photo';
      result.mediaMimeType = 'image/jpeg';
      result.mediaSize = photo.file_size;
      result.mediaUrl = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, 'image/jpeg'));
    } else {
      result.text = '[文件] ' + result.text;
      result.mediaType = 'file';
      result.mediaMimeType = (file ?? audio)?.mime_type ?? 'application/octet-stream';
      result.mediaSize = (file ?? audio)!.file_size;
      result.mediaUrl = await createShortUrl(await fileIdToUrl(fileId, fileUniqueId!, result.mediaMimeType));
    }
    return result;
  }

  private transformUser(user?: User): string {
    return user?.username ?? ((user?.first_name ?? '') + ' ' + (user?.last_name ?? '')).trim();
  }
}

export default new TelegramBotClient();
