export type StudioDraft = {
  title: string;
  artist: string;
  tokenReference: string;
  proposedClose: string;
};

export type StudioState =
  | { kind: "editing"; draft: StudioDraft }
  | { kind: "reviewing"; draft: StudioDraft };

export type StudioAction =
  | { kind: "change-title"; value: string }
  | { kind: "change-artist"; value: string }
  | { kind: "change-token-reference"; value: string }
  | { kind: "change-proposed-close"; value: string }
  | { kind: "review" }
  | { kind: "edit" }
  | { kind: "reset" };

export function emptyStudioDraft(): StudioDraft {
  return { title: "", artist: "", tokenReference: "", proposedClose: "" };
}

export function initialStudioState(): StudioState {
  return { kind: "editing", draft: emptyStudioDraft() };
}

export function studioPreparation(state: StudioState, action: StudioAction): StudioState {
  switch (action.kind) {
    case "change-title":
      return { kind: "editing", draft: { ...state.draft, title: action.value } };
    case "change-artist":
      return { kind: "editing", draft: { ...state.draft, artist: action.value } };
    case "change-token-reference":
      return { kind: "editing", draft: { ...state.draft, tokenReference: action.value } };
    case "change-proposed-close":
      return { kind: "editing", draft: { ...state.draft, proposedClose: action.value } };
    case "review":
      return { kind: "reviewing", draft: state.draft };
    case "edit":
      return { kind: "editing", draft: state.draft };
    case "reset":
      return initialStudioState();
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
