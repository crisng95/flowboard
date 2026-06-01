export interface HandleDropState {
  inProgress: boolean;
  hovered: boolean;
  selected: boolean;
  hasEdge: boolean;
}

export type HandleDropDecision = "droppable" | "visible-idle" | "idle-hidden";

export function targetHandleDropState(state: HandleDropState): HandleDropDecision {
  if (state.inProgress) return "droppable";
  if (state.hovered || state.selected || state.hasEdge) return "visible-idle";
  return "idle-hidden";
}
