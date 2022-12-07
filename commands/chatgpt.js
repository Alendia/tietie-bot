const ChatGPT = require('../modules/chatgpt');
const { getChatGPTToken } = require('../modules/database');

module.exports = async (ctx) => {
  const { message } = ctx;
  const chatId = message.chat.id;
  const token = await getChatGPTToken(chatId);
  if (!token) {
    ctx.reply('当前会话未设置 Token，请使用 /chatgpt_token <session_token> 设置。Token 需要在 chat.openai.com/chat 页面上获取 Cookie 获得。', { reply_to_message_id: message.message_id });
    return;
  }
  const question = message.text.trim().split(/\s+/)[1];
  if (!question) {
    ctx.reply('问题不能为空。', { reply_to_message_id: message.message_id });
    return;
  }
  const chatbot = ChatGPT.getInstance(token);
  const replyMessage = await ctx.reply('ChatGPT 正在思考…', { reply_to_message_id: message.message_id });
  try {
    let lastAnswer = '';
    for await (const answer of chatbot.ask(question)) {
      await Promise.all([
        ctx.telegram.editMessageText(chatId, replyMessage.message_id, undefined, answer + '…'),
        new Promise(r => setTimeout(r, 1000)),
      ]);
      lastAnswer = answer;
    }
    await ctx.telegram.editMessageText(chatId, replyMessage.message_id, undefined, lastAnswer);
  } catch (e) {
    console.error(e);
    ctx.telegram.editMessageText(chatId, replyMessage.message_id, undefined, '请求失败了，可能是接口被限频或者 token 失效，请过一会再问我这个问题。\n' + e.message);
  }
};
