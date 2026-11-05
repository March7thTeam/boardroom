import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { invalidateBoardEventQueries } from "../../apps/web/src/hooks/boardEventInvalidation";

const clients: QueryClient[] = [];
const unsubscribers: (() => void)[] = [];

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  function observe(key: string[]) {
    let fetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => ({ revision: ++fetches }),
      initialData: { revision: 0 },
    });
    unsubscribers.push(observer.subscribe(() => {}));
    return () => fetches;
  }
  return { client, observe };
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const client of clients.splice(0)) client.clear();
});

describe("board event cache refresh", () => {
  it("refetches the card and its independent negotiation data after a proposal or evidence event", async () => {
    const { client, observe } = harness();
    const boardFetches = observe(["board", "prj_a"]);
    const detailFetches = observe(["card", "c_a"]);
    const negotiationFetches = observe(["card-negotiation", "c_a"]);
    await invalidateBoardEventQueries(client, "prj_a", new Set(["c_a"]));
    expect([boardFetches(), detailFetches(), negotiationFetches()]).toEqual([1, 1, 1]);
    expect(client.getQueryData(["card-negotiation", "c_a"])).toEqual({ revision: 1 });
  });

  it("refreshes an observed floating card without relying on the selected tab", async () => {
    const { client, observe } = harness();
    const firstDetail = observe(["card", "c_a"]);
    const firstNegotiation = observe(["card-negotiation", "c_a"]);
    const floatingDetail = observe(["card", "c_b"]);
    const floatingNegotiation = observe(["card-negotiation", "c_b"]);
    await invalidateBoardEventQueries(client, "prj_a", new Set(["c_b"]));
    expect([firstDetail(), firstNegotiation(), floatingDetail(), floatingNegotiation()]).toEqual([0, 0, 1, 1]);
  });

  it("resyncs all visible cards and marks inactive cached cards stale without fetching them", async () => {
    const { client, observe } = harness();
    const detailA = observe(["card", "c_a"]);
    const negotiationA = observe(["card-negotiation", "c_a"]);
    const detailB = observe(["card", "c_b"]);
    const negotiationB = observe(["card-negotiation", "c_b"]);
    client.setQueryData(["card", "c_closed_window"], { revision: 0 });
    await invalidateBoardEventQueries(client, "prj_a", null);
    expect([detailA(), negotiationA(), detailB(), negotiationB()]).toEqual([1, 1, 1, 1]);
    expect(client.getQueryState(["card", "c_closed_window"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["card", "c_closed_window"])).toEqual({ revision: 0 });
  });
});
