import type { TemplateStatus } from "./task-status";

/**
 * Contains the rendered content and outcome for one Bark notification.
 */
export interface TaskNotification {
  // Lifecycle status rendered into the title/body templates: a terminal
  // task status, or "waiting" for an ask-tool notification.
  status: TemplateStatus;
  // Full text rendered into the `{message}` template variable: the final
  // assistant message, or the joined ask questions for ask notifications.
  message: string;
  // Rendered Bark notification title.
  title: string;
  // Rendered Bark notification body.
  body: string;
}
