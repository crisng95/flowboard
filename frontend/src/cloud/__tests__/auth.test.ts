import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthDependentState,
  mapAuthError,
  type AuthFlowMode,
} from "../auth";
import { useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { useReferencesStore } from "../../store/references";

describe("mapAuthError", () => {
  it("normalizes unconfirmed email errors", () => {
    expect(mapAuthError(new Error("Email not confirmed"), "sign_in")).toContain(
      "not confirmed",
    );
  });

  it("normalizes invalid credentials errors", () => {
    expect(
      mapAuthError(new Error("Invalid login credentials"), "sign_in"),
    ).toBe("Incorrect email or password.");
  });

  it("uses mode-specific fallback copy", () => {
    const modes: AuthFlowMode[] = ["sign_up", "forgot_password", "reset_password"];
    const outputs = modes.map((mode) => mapAuthError(new Error("unexpected"), mode));
    expect(outputs[0]).toContain("create your account");
    expect(outputs[1]).toContain("reset email");
    expect(outputs[2]).toContain("update your password");
  });
});

describe("clearAuthDependentState", () => {
  beforeEach(() => {
    useBoardStore.setState({
      showAuthModal: true,
      authModalMode: "reset_password",
      showExtensionModal: true,
    });
    useGenerationStore.setState({
      paygateTier: "PAYGATE_TIER_ONE",
      projectId: "proj-123",
    });
    useReferencesStore.setState({
      items: [
        {
          id: 1,
          mediaId: "media-1",
          url: null,
          label: "Ref",
          kind: "reference",
          aiBrief: null,
          aspectRatio: null,
          tags: [],
          pinned: false,
          position: 0,
          sourceBoardId: null,
          sourceNodeShortId: null,
          createdAt: new Date().toISOString(),
        },
      ],
      loading: true,
      error: "boom",
      query: "abc",
    });
  });

  it("resets frontend auth-dependent state", () => {
    clearAuthDependentState();

    const board = useBoardStore.getState();
    const generation = useGenerationStore.getState();
    const references = useReferencesStore.getState();

    expect(board.showAuthModal).toBe(false);
    expect(board.authModalMode).toBe("sign_in");
    expect(board.showExtensionModal).toBe(false);
    expect(generation.paygateTier).toBeNull();
    expect(generation.projectId).toBeNull();
    expect(references.items).toEqual([]);
    expect(references.loading).toBe(false);
    expect(references.error).toBeNull();
    expect(references.query).toBe("");
  });
});
