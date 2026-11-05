import { describe, expect, it } from "vitest";
import { assertTransition, nextStatus, type CardStatus } from "../../src/domain/state-machine";
import { HttpError } from "../../src/lib/http-error";

const STATUSES: CardStatus[] = ["open", "engaged", "running", "review", "closed"];

describe("state machine", () => {
  it("allows every documented transition", () => {
    expect(nextStatus("commit")).toBe("engaged");
    expect(nextStatus("cancel")).toBe("closed");
    expect(nextStatus("start")).toBe("running");
    expect(nextStatus("deliver")).toBe("review");
    expect(nextStatus("retry")).toBe("engaged");
    expect(nextStatus("rework")).toBe("engaged");
    expect(nextStatus("verdict")).toBe("closed");
    expect(nextStatus("reopen")).toBe("open");
  });

  it("rejects illegal transitions with 409", () => {
    for (const status of STATUSES) {
      if (status !== "open") {
        expect(() => assertTransition("commit", status)).toThrowError(HttpError);
      }
      if (status !== "closed") {
        expect(() => assertTransition("reopen", status)).toThrowError(HttpError);
      }
      if (status !== "running") {
        expect(() => assertTransition("deliver", status)).toThrowError(HttpError);
      }
    }
  });

  it("turns needs_more into a rework transition back to engaged", () => {
    expect(() => assertTransition("rework", "review")).not.toThrow();
    // A reworked card must be able to start a fresh attempt and deliver again.
    expect(() => assertTransition("start", "engaged")).not.toThrow();
    expect(() => assertTransition("deliver", "running")).not.toThrow();
    for (const status of ["open", "engaged", "running", "closed"] as CardStatus[]) {
      expect(() => assertTransition("rework", status)).toThrowError(HttpError);
    }
  });

  it("only allows cancelled as the cancel outcome", () => {
    expect(() => assertTransition("cancel", "open", "cancelled")).not.toThrow();
    expect(() => assertTransition("cancel", "open", "done")).toThrowError(HttpError);
  });

  it("only allows done or rejected as verdict outcomes", () => {
    expect(() => assertTransition("verdict", "review", "done")).not.toThrow();
    expect(() => assertTransition("verdict", "review", "rejected")).not.toThrow();
    expect(() => assertTransition("verdict", "review", "cancelled")).toThrowError(HttpError);
  });
});
