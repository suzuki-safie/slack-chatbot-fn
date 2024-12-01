import "source-map-support/register";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { App, AwsLambdaReceiver } from "@slack/bolt";
import { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse";
import { Handler } from "aws-lambda";
import { z } from "zod";
import { parseMessageURL } from "./slack";
import type { Event } from "./stack.chatbot-handler";
const Mustache = require("mustache");

// Define slack custom function inputs type
// see manifest.json and https://api.slack.com/automation/functions/custom-bolt#inputs-outputs
const Inputs = z.object({
  api_endpoint: z.string().url().optional(),
  api_key: z.string().min(1).optional(),
  message_url: z.string().url(),
  prompt_text: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  preamble: z.string().min(1).optional(),
  fetch_thread_limit: z.number().int().nonnegative().lte(1000).default(0),
  reply_to: z.string().url().or(z.string().regex(/^[UW]\S+$/)).optional(),
});
type Inputs = z.infer<typeof Inputs>;

// AWS clients
const lambdaClient = new LambdaClient({});

// Initialize slack app
const receiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// Listen for function invocation
app.function("bot_invoke", async ({ inputs, client, complete, fail }) => {
  try {
    // parse Slack custom function inputs
    const {
      api_endpoint: apiEndpoint = process.env.DEFAULT_API_ENDPOINT!,
      api_key: apiKey = process.env.DEFAULT_API_KEY!,
      message_url: messageUrl,
      prompt_text: promptText = "<message>\n{{message}}\n</message>\nmessageタグの質問文に対して回答してください。Markdown形式が使用できます。",
      model = "claude-v3.5-sonnet",
      preamble: preambleText,
      fetch_thread_limit,
      reply_to: replyTo = messageUrl,
    } = Inputs.parse(inputs);
    console.log("Starting bot_invoke function", { apiEndpoint, apiKey: "*".repeat(apiKey.length), messageUrl, promptText, model, preambleText, fetch_thread_limit, replyTo });

    // parse message_url
    const { channel, ts, threadTs } = parseMessageURL(messageUrl);

    // fetch thread messages
    let message: MessageElement | null = null;
    const thread: MessageElement[] = [];
    if (fetch_thread_limit > 0 || !threadTs) {
      const res = await client.conversations.replies({
        channel,
        ts: threadTs ?? ts,
        limit: fetch_thread_limit || 1,
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
      const res = await client.conversations.replies({
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

    // build propmt message from template and slack message
    const templateContext = {
      url: messageUrl,
      ts,
      timestamp: new Date(parseFloat(ts)).toISOString(),
      user: message.user ?? "",
      message: message.text ?? "",
      text: message.text ?? "",
      thread: thread.map(m => {
        return {
          ts: m.ts,
          timestamp: (m.ts) ? new Date(parseFloat(m.ts)).toISOString() : m.ts,
          user: m.user ?? "",
          text: m.text ?? "",
        };
      }),
    };
    const prompt = Mustache.render(promptText, templateContext);
    const preamble = (preambleText) ? Mustache.render(preambleText, templateContext) : undefined;

    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.CHATBOT_HANDLER_FUNCTION_NAME!,
      InvocationType: "Event",
      Payload: JSON.stringify({
        apiEndpoint,
        apiKey,
        prompt,
        model,
        parseMarkdown: true,
        preamble: preamble,
        replyTo,
      } as Event),
    }));
    console.log("Invoked chatbot-handler function", { prompt, replyTo });

    await complete({});
  } catch (error) {
    console.error("Error: ", error);
    await fail({ error: `Failed to handle a function request: ${error}`, });
  }
});


export const handler: Handler = async (event, context, callback) => {
  const handler = await receiver.start();
  return handler(event, context, callback);
};
