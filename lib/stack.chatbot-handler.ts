import "source-map-support/register";
import { KnownBlock, WebClient } from "@slack/web-api";
import { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse";
import { Handler } from 'aws-lambda';
import ky from "ky";
import { z } from "zod";
import { parseMessageURL } from "./slack";
const Mustache = require("mustache");


// bedrock-claude-chat published API types
// POST /conversation - Post Message
// https://aws-samples.github.io/bedrock-claude-chat/#tag/published_api/operation/post_message_conversation_post
const PostMessageResponse = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});
type PostMessageResponse = z.infer<typeof PostMessageResponse>;

// GET /conversation/{conversationId} - Get Conversation
// https://aws-samples.github.io/bedrock-claude-chat/#tag/published_api/operation/get_conversation_conversation__conversation_id__get
const GetConversationResponse = z.object({
  id: z.string(),
  title: z.string(),
  createTime: z.number(),
  messageMap: z.record(z.string(), z.object({
    role: z.string(),
    content: z.array(z.object({
      contentType: z.string(),
      mediaType: z.string().nullish(),
      fileName: z.string().nullish(),
      body: z.string(),
    })),
    model: z.string(),
    children: z.array(z.string().min(1)),
    feedback: z.object({
      thumbsUp: z.boolean(),
      category: z.string(),
      comment: z.string(),
    }).nullable(),
    usedChunks: z.array(z.object({
      content: z.string(),
      contentType: z.string(),
      source: z.string(),
      rank: z.number(),
    })).nullable(),
    parent: z.string().nullable(),
  })),
  lastMessageId: z.string().min(1),
  botId: z.string().min(1).nullable(),
  shouldContinue: z.boolean(),
});
type GetConversationResponse = z.infer<typeof GetConversationResponse>;


// Slack API client
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);


// Lambda event type
const Event = z.object({
  apiEndpoint: z.string().url(),
  apiKey: z.string().min(1),
  messageUrl: z.string().url(),
  promptText: z.string().min(1),
  model: z.string().min(1),
  preambleText: z.string().min(1).optional(),
  fetchThreadLimit: z.number().int().nonnegative().lte(1000),
  replyTo: z.string().url().or(z.string().regex(/^[UW]\S+$/)),
});
export type Event = z.infer<typeof Event>;


// Lambda handler
export const handler: Handler<Event> = async (event, context) => {
  const {
    apiEndpoint,
    apiKey,
    messageUrl,
    promptText,
    model,
    preambleText,
    fetchThreadLimit,
    replyTo,
  } = Event.parse(event);
  console.log("Starting chatbot-handler", {
    apiEndpoint,
    apiKey: "*".repeat(apiKey.length),
    messageUrl,
    promptText,
    model,
    preambleText,
    fetchThreadLimit,
    replyTo,
  });

  // parse message_url
  const { channel, ts, threadTs } = parseMessageURL(messageUrl);

  const [[message, thread], users] = await Promise.all([
    (async () => {
      // fetch thread messages
      let message: MessageElement | null = null;
      const thread: MessageElement[] = [];
      if (fetchThreadLimit > 0 || !threadTs) {
        const res = await slackClient.conversations.replies({
          channel,
          ts: threadTs ?? ts,
          limit: fetchThreadLimit || 1,
        });
        for (const m of (res.messages ?? [])) {
          thread.push(m);
          if (m.ts === ts) {
            message = m;
          }
        }
      }
      // if message is not in fetched thread, fetch the message directly
      if (!message && threadTs) {
        const res = await slackClient.conversations.replies({
          channel,
          ts: threadTs,
          latest: ts,
          limit: 1,
          inclusive: true,
        });
        if (res.messages && res.messages.length > 0) {
          message = res.messages[res.messages.length - 1];
          thread.push(message);
        }
      }
      if (!message) {
        throw new Error("Failed to fetch message specified by message_url");
      }
      return [message, thread];
    })(),
    (async () => {
      // fetch all users
      const res = await slackClient.users.list({});
      return new Map(res.members!.map(m => [m.id!, m.name!]));
    })(),
  ])

  // build propmt message from template and slack message
  const templateContext = {
    url: messageUrl,
    ts,
    timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
    user: message.user ? (users.get(message.user) ?? message.user) : "",
    message: message.text ?? "",
    text: message.text ?? "",
    thread: thread.map(m => {
      return {
        ts: m.ts,
        timestamp: (m.ts) ? new Date(parseFloat(m.ts) * 1000).toISOString() : "",
        user: m.user ? (users.get(m.user) ?? m.user) : "",
        text: m.text ?? "",
      };
    }),
  };
  const prompt = Mustache.render(promptText, templateContext);
  const preamble = (preambleText) ? Mustache.render(preambleText, templateContext) : undefined;

  // create Bot API client
  const api = ky.create({
    prefixUrl: apiEndpoint,
    headers: { "x-api-key": apiKey },
    timeout: 20000,
  });
  console.log("prompt: ", prompt.slice(0, 1000));

  // チャットボットにメッセージを送信
  const { conversationId, messageId } = PostMessageResponse.parse(await api.post("conversation", {
    json: {
      message: {
        content: [{ contentType: "text", body: prompt }],
        model,
      },
    },
  }).json());
  console.log("Posted prompt to bedrock-claude-chat API", {conversationId, messageId});

  for (let i = 0; i < 6; i++) {
    // 指数的にスリープ [2s, 4s, 8s, 16s, 32s, 64s] => 126s
    await new Promise(resolve => setTimeout(resolve, 2 * Math.pow(2, i) * 1000));

    // チャットボットからの応答を取得
    let res: any;
    try {
      res = await api.get(`conversation/${conversationId}`);
    } catch (ex: any) {
      if (ex.name === "HTTPError" && ex.response.status === 404) {
        // retry
        console.log("GET /api/conversation/{conversationId} returned 404, retrying...");
        continue;
      }
      throw ex;
    }
    const conversation = GetConversationResponse.parse(await api.get(`conversation/${conversationId}`).json());
    const promptMessage = conversation.messageMap[messageId];
    if (promptMessage.children.length === 0) {
      // retry
      console.log("GET /api/conversation/{conversationId} returned with no reply, retrying...");
      continue;
    }

    // チャットボットが応答した場合、応答メッセージを返す
    const replyText = conversation.messageMap[promptMessage.children[0]].content.find(c => c.contentType === "text")?.body || "";
    console.log("Received reply from bedrock-claude-chat API", {replyText: (replyText.length > 1000) ? replyText.slice(0, 1000) + "..." : replyText});

    let preambleBlocks: KnownBlock[] = [];
    if (typeof preamble === "string") {
      preambleBlocks = [{"type": "section", "text": {"type": "mrkdwn", "text": preamble}}];
    } else if (Array.isArray(preamble)) {
      preambleBlocks = preamble as any;
    }

    let replyParams: { channel: string, thread_ts?: string };
    if (/^[UW]\S+/.test(replyTo)) {
      const res = await slackClient.conversations.open({users: replyTo});
      replyParams = {channel: res.channel!.id!};
    } else {
      const { channel, ts, threadTs } = parseMessageURL(replyTo);
      replyParams = {channel, thread_ts: threadTs ?? ts};
    }

    await slackClient.chat.postMessage({
      ...replyParams,
      blocks: [
        ...preambleBlocks,
        {"type": "section", "text": {"type": "mrkdwn", "text": replyText}},
      ],
    });
    console.log("Posted reply to Slack");
    return;
  }

  // チャットボットが時間内に応答しなかった場合
  throw new Error("ChatBot did not respond in time (126s)");
};
