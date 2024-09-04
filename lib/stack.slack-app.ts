import "source-map-support/register";
import { App, AwsLambdaReceiver } from "@slack/bolt";
import { z } from "zod";
import { Handler } from "aws-lambda";
const Mustache = require("mustache");
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { Event } from "./stack.chatbot-handler";

// Define slack custom function inputs type
// see manifest.json and https://api.slack.com/automation/functions/custom-bolt#inputs-outputs
const Inputs = z.object({
  api_endpoint: z.string().url().optional(),
  api_key: z.string().min(1).optional(),
  message_url: z.string().url(),
  prompt_text: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  preamble: z.string().min(1).optional(),
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
      preamble,
    } = Inputs.parse(inputs);
    console.log("Starting bot_invoke function", { apiEndpoint, apiKey: "*".repeat(apiKey.length), messageUrl, promptText, model, preamble });

    // retrieve message text from message_url
    const m = messageUrl?.match(/\/archives\/(\w+)\/p(\d+)$/);
    if (!m) {
      throw new Error("Invalid message_url format");
    }
    const channel = m[1];
    const ts = m[2].slice(0, -6) + "." + m[2].slice(-6);
    const res = await client.conversations.history({
      channel,
      oldest: ts,
      inclusive: true,
      limit: 1,
    });
    if (!res.messages || res.messages.length === 0) {
      throw new Error("Message specified by message_url not found");
    }
    const messageText = res.messages[0].text || "";

    // build propmt message from template and slack message
    const prompt = Mustache.render(promptText, { message: messageText });

    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.CHATBOT_HANDLER_FUNCTION_NAME!,
      InvocationType: "Event",
      Payload: JSON.stringify({
        apiEndpoint,
        apiKey,
        prompt,
        model,
        channel,
        threadTs: ts,
        parseMarkdown: true,
        preamble: preamble || undefined,
      } as Event),
    }));
    console.log("Invoked chatbot-handler function", {prompt, channel, threadTs: ts});

    await complete({});
  } catch (error) {
    await fail({ error: `Failed to handle a function request: ${error}`, });
  }
});


export const handler: Handler = async (event, context, callback) => {
  const handler = await receiver.start();
  return handler(event, context, callback);
};
