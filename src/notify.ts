import { BarkClient, BarkMessageBuilder } from "@hoshinorei/bark-sdk";
import type { BarkNotifierConfig } from "./types/bark-notifier-config";
import type { BarkSender } from "./types/bark-sender";
import type { TaskNotification } from "./types/task-notification";


/**
 * The real SDK-backed sender /**
 * The SDK-backed default sender behind {@link sendBarkNotification}.
 *
 * Each `send` constructs a `BarkClient` from `config.serverUrl`, builds the
 * Bark message from the notification title/body plus `config.key` (and
 * `config.group` when present), and pushes it. Rejections are the SDK's own
 * (`BarkResponseError` and friends) and are intentionally not wrapped.
 *
 * This is the only module that imports the SDK: tests inject a
 * {@link BarkSender} instead of exercising HTTP, and the hook boundary
 * reaches Bark only through {@link sendBarkNotification}. The device key
 * is sent to the configured Bark server (that is its purpose) and is never
 * logged or surfaced anywhere else by this module.
 *
 * @returns {BarkSender} A sender whose `send` performs one Bark push.
 */
function createBarkSender(): BarkSender {
  return {
    async send(notification, config): Promise<void> {
      const client = new BarkClient(config.serverUrl);
      let builder = new BarkMessageBuilder()
        .body(notification.body)
        .deviceKey(config.key)
        .title(notification.title);
      if (config.group) builder = builder.group(config.group);
      await client.push(builder.build());
    },
  };
}

/**
 * Deliver `notification` to Bark using `config`, optionally via `sender`.
 *
 * Defaults `sender` to {@link createBarkSender}. A rejected sender propagates
 * its rejection unchanged — this function never swallows delivery failures —
 * so the invoking hook boundary can catch, log, and contain it. Pass an injected `sender` to test or drive delivery without any network access.
 *
 * @param {TaskNotification} notification - Rendered title, body, status,
 *   and message for the Bark push.
 * @param {BarkNotifierConfig} config - Resolved server URL, device key,
 *   optional group, and templates.
 * @param {BarkSender} [sender] - Delivery implementation; defaults to the
 *   SDK-backed {@link createBarkSender}. Inject one to avoid network
 *   access in tests.
 * @returns {Promise<void>} Resolves on delivery; rejects with the sender's
 *   rejection, which callers are expected to catch and log.
 */
export async function sendBarkNotification(
  notification: TaskNotification,
  config: BarkNotifierConfig,
  sender?: BarkSender,
): Promise<void> {
  const effectiveSender = sender ?? createBarkSender();
  await effectiveSender.send(notification, config);
}
