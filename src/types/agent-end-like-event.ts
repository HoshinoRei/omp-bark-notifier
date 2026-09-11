/**
 * Describes the minimum agent_end shape consumed by the renderer and classifier.
 */
export interface AgentEndLikeEvent {
  // OMP transcript entries produced during the agent task.
  messages: unknown[];
  // Whether OMP has scheduled an automatic continuation.
  willContinue?: boolean;
}
