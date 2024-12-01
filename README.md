# slack-chatbot-fn

slack-chatbot-fn is a Slack app that acts as Slack Workflow Custom Function to interact with [bedrock-claude-chat](https://github.com/aws-samples/bedrock-claude-chat) published API. slack-chatbot-fn consists of several AWS Lambda function and CDK stack to deploy them.

## Architecture
```mermaid
flowchart LR
  slack[Slack]
  chat[bedrock-claude-chat]
  subgraph AWS Account
    app[Slack App<br>Lambda with Function URL]
    handler[Bot Handler<br>Lambda]
  end

  slack -- 1 Event to<br>Request URL --> app
  app -- 2 Invoke --> handler
  handler -- 3 Conversation --> chat
  chat -- 4 Reply --> handler
  handler -- 5 Reply --> slack
```

## Usage
1. copy `.env.example` to `.env`
2. `source .env && npx cdk deploy` to deploy the stack.
   Note the `LambdaFunctionURL` and `ElasticIP` from the output.
   NOTE: at this point app is not properly configured yet.
3. On bedrock-claude-chat, allow API access from `ElasticIP` noted above.
4. On bedrock-claude-chat, create a default chatbot and fill `DEFAULT_API_ENDPOINT` and `DEFAULT_API_KEY` in `.env`
5. On Slack, create and install a new app with `manifest.json` and fill `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`.
   NOTE: `settings.event_subscription.request_url` should be `LambdaFunctionURL`
6. `source .env && npx cdk deploy` to update the stack.
7. On Slack, add the app to a channel and create new workflow.
   The workflow should be triggerd with an emoji reaction and execute a custom step `Custom/slack-chatbot-fn/Invoke ChatBot`.
   Set custom step's `Slack Message URL` to `{} Link to the message that was reacted to`

## Slack Function Custom Parameters
- `api_endpoint`: API endpoint URL, published by [Bedrock Claude Chat](https://github.com/aws-samples/bedrock-claude-chat/blob/v2/docs/PUBLISH_API.md)
- `api_key`, API key for the endpoint
- `model`: LLM model name to use. default: `claude-v3.5-sonnet`. see https://aws-samples.github.io/bedrock-claude-chat/#tag/published_api/operation/post_message_conversation_post
- `message_url`: Slack message url, like `https://team.slack.com/archives/C00000000000/p0000000000000000` or `https://team.slack.com/archives/C00000000000/p0000000000000000?thread_ts=0000000000.000000`
- `prompt_text`: Prompt text to input to LLM model. Text is [mustache](https://github.com/janl/mustache.js) template with following variables.
   - `text`: Text content of the message specified with `message_url`
   - `user`: User ID of the message specified with `message_url`
   - `ts`: Message timestamp in Slack format. i.e. `0000000000.000000`
   - `timestamp`: Message timestamp in RFC3339 format
   - `thread`: List of messages object in the thread which the message specified with `message_url` belongs to. available if `fetch_thread_limit` is set to >0.
     - `ts`: Reply timestamp in Slack format
     - `timestamp`: Reply timestamp in RFC3339 format
     - `user`: User ID of the reply
     - `text`: Text content of the reply
- `preamble`: Output preamble of reply wrote to `message_url`
- `fetch_thread_limit`: Number of messages to fetch in the thread. default: `0`

## Example prompts
### Answer to a message
```
<MESSAGE>{{text}}</MESSAGE>
Answer to the message above.
```

### Summarize a thread
```
<THREAD>
  {{ #thread }}
  <MESSAGE>
   <TIMESTAMP>{{ timestamp }}</TIMESTAMP>
   <USER>{{ user }}</USER>
   <TEXT>{{ text }}</TEXT>
  </MESSAGE>
  {{ /thread }}
</THREAD>
Summarize the thread above.
```
