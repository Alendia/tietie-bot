const jieba = require('nodejieba');
const { putSearchData, generateSearchResultsByKeyword, deleteMessageById } = require('../database/search');

// 搜索结果需要同时命中的关键词比例
const HIT_RATIO = 0.75;

const forwardedMessageMap = {};

const getAllKeywords = (text) => {
  const words = jieba.cut(text, true);
  const markovWords = jieba.cutHMM(text);
  return [...new Set([...words, ...markovWords])];
};

const recordChatMessage = (ctx) => {
  try {
    const { message_id: messageId, text, date, caption } = ctx.message;
    if (!text || text.startsWith('/')) return;
    const words = getAllKeywords(text || caption || '');
    if (!words.length) return;
    putSearchData(ctx.chat.id, messageId, words, Math.floor(date * 1000));
  } catch (e) {
    console.error(e);
  }
}

const recordEditedMessage = (ctx) => {
  try {
    const { message_id: messageId, text, date, caption } = ctx.editedMessage;
    deleteMessageById(ctx.chat.id, messageId);
    if (!text || text.startsWith('/')) return;
    const words = getAllKeywords(text || caption || '');
    if (!words.length) return;
    putSearchData(ctx.chat.id, messageId, words, Math.floor(date * 1000));
  } catch (e) {
    console.error(e);
  }
}

const searchForKeywordsInChat = async (chatId, keywordsStr, skipCount = 0) => {
  const splittedKeywords = new Set();
  const splittedKw = getAllKeywords(keywordsStr).map((k) => k.trim()).filter((k) => k);
  for (const k of splittedKw) {
    if ('的一不是了我人在有这来它中大上个国说也子'.split('').includes(k)) continue;
    splittedKeywords.add(k);
  }
  const finalKeywords = [...splittedKeywords.values()];
  const generators = finalKeywords.map(kw => generateSearchResultsByKeyword(chatId, kw));
  const generatorCurrentItems = await Promise.all(generators.map(async gen => (await gen.next()).value));

  while (generatorCurrentItems.some(k => k)) {
    // 检查此时所有关键词中匹配同一条消息的数量是否达到标准
    const candidateMessageIds = generatorCurrentItems.filter(k => k).map(k => k.message_id);
    const messageCountMap = {};
    let mostHitMessageId = null;
    for (const messageId of candidateMessageIds) {
      messageCountMap[messageId] = (messageCountMap[messageId] || 0) + 1;
      if (!mostHitMessageId || messageCountMap[messageId] > messageCountMap[mostHitMessageId]) {
        mostHitMessageId = messageId;
      }
    }
    if (mostHitMessageId && messageCountMap[mostHitMessageId] >= generators.length * HIT_RATIO) {
      // 超过一定比例的关键词命中了同一条消息
      const message = generatorCurrentItems.find(k => k.message_id === mostHitMessageId);
      if (skipCount <= 0) {
        return message;
      }
      skipCount -= 1;
    }

    // 每次取所有关键词中最晚的一条，向前查一次数据
    const indexedItems = generatorCurrentItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item);

    if (!indexedItems.length) break;
    const latestIndex = indexedItems.reduce((a, b) => a.item.timestamp > b.item.timestamp ? a : b)?.index;
    generatorCurrentItems[latestIndex] = (await generators[latestIndex].next()).value;
  }

  return null;
}

const renderSearchResult = async (ctx, chatId, record, keywordsStr, skipCount) => {
  if (ctx.callbackQuery) {
    const forwardedMessageId = forwardedMessageMap[ctx.chat.id];
    if (forwardedMessageId) await ctx.telegram.deleteMessage(ctx.chat.id, forwardedMessageId);
  }
  delete forwardedMessageMap[ctx.chat.id];

  const replyOrEditMessage = ctx.callbackQuery
    ? ctx.telegram.editMessageText.bind(ctx.telegram, ctx.chat.id, ctx.callbackQuery.message.message_id, undefined)
    : ctx.reply.bind(ctx);

  if (!record) {
    await replyOrEditMessage(skipCount ? `没有找到其它有关 ${keywordsStr} 的消息` : `没有找到有关 ${keywordsStr} 的消息`, {
      reply_to_message_id: ctx.message?.message_id,
      reply_markup: {
        inline_keyboard: skipCount ? [[
          { text: '后一条', callback_data: `search:${chatId}:${keywordsStr}:${skipCount - 1}` },
        ]] : [],
      }
    });
    return;
  }

  const url = `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${record.message_id}`;
  await replyOrEditMessage([
    `${keywordsStr} 的第 ${skipCount + 1} 条搜索结果：\n🕙 ${new Date(record.timestamp).toLocaleString('zh-CN')}`,
    `${!ctx.callbackQuery ? '\n⚠️ Bot 仅存储消息 id、会话 id、关键词 hash 和时间戳信息，不保留消息内容、群组和发送者信息，消息转发功能由 Telegram 提供' : ''}`
  ].join('\n').trim(), {
    reply_to_message_id: ctx.message?.message_id,
    reply_markup: {
      inline_keyboard: [[
        { text: '前一条', callback_data: `search:${chatId}:${keywordsStr}:${skipCount + 1}` },
        ...(skipCount ? [{ text: '后一条', callback_data: `search:${chatId}:${keywordsStr}:${skipCount - 1}` }] : []),
        { text: '🔗', url },
      ]]
    },
  });

  try {
    const { message_id } = await ctx.telegram.forwardMessage(ctx.chat.id, chatId, record.message_id);
    forwardedMessageMap[ctx.chat.id] = message_id;
  } catch (e) {
    if (e.description === 'Bad Request: message to forward not found') {
      const { message_id } = await ctx.reply('[该条消息不存在或已被删除，对应的索引将被清理]');
      forwardedMessageMap[ctx.chat.id] = message_id;
      deleteMessageById(chatId, record.message_id);
      return;
    }
  }
};

module.exports = async (ctx) => {
  if (ctx.callbackQuery) {
    const { data } = ctx.callbackQuery;
    const [command, chatId, keywordsStr, skipCount] = data.split(':');
    if (command === 'search') {
      const record = await searchForKeywordsInChat(chatId, keywordsStr, Number(skipCount));
      await renderSearchResult(ctx, chatId, record, keywordsStr, Number(skipCount));
    }
    return;
  }
  if (ctx.message.chat.type !== 'private') {
    ctx.reply(`请在私聊中使用 \`/search ${ctx.message.chat.id}\` 加关键词搜索当前会话`, {
      reply_to_message_id: ctx.message.message_id,
      parse_mode: 'MarkdownV2',
    });
    return;
  }
  const { message } = ctx;
  const [chatId, ...keywords] = message.text.trim().split(/\s+/).slice(1);
  if (!chatId || !/^-?\d+$/.test(chatId) || !keywords.length) {
    ctx.reply(`请使用 \`/search <chatId>\` 加关键词搜索某个会话，其中 chatId 可在对应会话中输入 \`/search\` 获取`, {
      reply_to_message_id: ctx.message.message_id,
      parse_mode: 'MarkdownV2',
    });
    return;
  }
  if (chatId === ctx.message.chat.id) {
    ctx.reply('暂不支持搜索与机器人之间的会话。', {
      reply_to_message_id: ctx.message.message_id,
    });
    return;
  }
  const keywordsStr = keywords.join(' ');
  const record = await searchForKeywordsInChat(chatId, keywordsStr);
  await renderSearchResult(ctx, chatId, record, keywordsStr, 0);
}

module.exports.recordChatMessage = recordChatMessage;
module.exports.recordEditedMessage = recordEditedMessage;
