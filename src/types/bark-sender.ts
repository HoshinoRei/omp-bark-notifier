import type { BarkNotifierConfig } from "./bark-notifier-config";
import type { TaskNotification } from "./task-notification";

/**
 * Abstraction that delivers a rendered task notification through Bark.
 */
export interface BarkSender {
  // Sends the notification using resolved configuration; callers contain rejection.
  send(notification: TaskNotification, config: BarkNotifierConfig): Promise<void>;
}
