import "source-map-support/register";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { App, AwsLambdaReceiver } from "@slack/bolt";
import { Handler } from "aws-lambda";
import { z } from "zod";
import { parseMessageURL } from "./slack";
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
      fetch_thread_limit: fetchThreadLimit,
      reply_to: replyTo = messageUrl,
    } = Inputs.parse(inputs);
    console.log("Starting bot_invoke function", {
      apiEndpoint,
      apiKey: "*".repeat(apiKey.length),
      messageUrl,
      promptText,
      model,
      preambleText,
      fetchThreadLimit,
      replyTo,
    });

    // validate message_url
    parseMessageURL(messageUrl);

    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.CHATBOT_HANDLER_FUNCTION_NAME!,
      InvocationType: "Event",
      Payload: JSON.stringify({
        apiEndpoint,
        apiKey,
        messageUrl,
        promptText,
        model,
        preambleText,
        fetchThreadLimit,
        replyTo,
      } as Event),
    }));
    console.log("Invoked chatbot-handler function");

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
