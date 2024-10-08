import "source-map-support/register";
import { Handler } from 'aws-lambda';
import { z } from "zod";
import ky from "ky";
import { WebClient, KnownBlock } from "@slack/web-api";


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
  prompt: z.string().min(1),
  model: z.string().min(1),
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  parseMarkdown: z.boolean().optional(),
  preamble: z.union([
    z.string(),
    z.array(z.object({type: z.string()}) as any as z.ZodType<KnownBlock>),
  ]).optional(),
});
export type Event = z.infer<typeof Event>;


// Lambda handler
export const handler: Handler<Event> = async (event, context) => {
  const {
    apiEndpoint,
    apiKey,
    prompt,
    model,
    channel,
    threadTs,
    parseMarkdown = true,
    preamble,
  } = Event.parse(event);
  console.log("Starting chatbot-handler", {apiEndpoint, apiKey: "*".repeat(apiKey.length), prompt, model, channel, threadTs, parseMarkdown, preamble});

  // create Bot API client
  const api = ky.create({
    prefixUrl: apiEndpoint,
    headers: { "x-api-key": apiKey },
    timeout: 20000,
  });

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
    console.log("Received reply from bedrock-claude-chat API", {replyText: (replyText.length > 100) ? replyText.slice(0, 100) + "..." : replyText});

    let preambleBlocks: KnownBlock[] = [];
    if (typeof preamble === "string") {
      preambleBlocks = [{"type": "section", "text": {"type": "plain_text", "text": preamble}}];
    } else if (Array.isArray(preamble)) {
      preambleBlocks = preamble as any;
    }

    await slackClient.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      blocks: [
        ...preambleBlocks,
        {"type": "section", "text": {"type": parseMarkdown ? "mrkdwn": "plain_text", "text": replyText}},
      ],
    });
    console.log("Posted reply to Slack");
    return;
  }

  // チャットボットが時間内に応答しなかった場合
  throw new Error("ChatBot did not respond in time (126s)");
};
