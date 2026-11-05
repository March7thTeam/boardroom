import type { QueryClient } from "@tanstack/react-query";

/** Invalidate every view of changed cards, including detached windows. */
export async function invalidateBoardEventQueries(
  queryClient: QueryClient,
  projectId: string,
  cardIds: ReadonlySet<string> | null,
): Promise<void> {
  const queryKeys: string[][] = [["board", projectId]];
  if (cardIds === null) {
    queryKeys.push(["card"], ["card-negotiation"]);
  } else {
    for (const cardId of cardIds) {
      queryKeys.push(["card", cardId], ["card-negotiation", cardId]);
    }
  }
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
