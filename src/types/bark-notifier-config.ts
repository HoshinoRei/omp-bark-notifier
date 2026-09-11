import type { TemplateStatus } from "./task-status";

/**
 * Contains the resolved settings used to send one Bark notification.
 */
export interface BarkNotifierConfig {
  // Bark server base URL used by the Bark client.
  serverUrl: string;
  // Secret Bark device key; it must never appear in logs.
  key: string;
  // Optional Bark notification group.
  group?: string;
  // Title template containing the supported placeholders.
  titleTemplate: string;
  // Body template containing the supported placeholders.
  bodyTemplate: string;
  // Title template for ask-tool waiting notifications.
  askTitleTemplate: string;
  // Body template for ask-tool waiting notifications.
  askBodyTemplate: string;
  // Statuses that produce a notification: the three terminal task
  // statuses plus `waiting` for ask-tool waits.
  statuses: TemplateStatus[];
}
