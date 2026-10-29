/**
 * Set equality over two string lists, ignoring order and treating repeats as
 * the duplicates they are.
 *
 * Every caller is comparing an *identity claim* that carries a set — the OAuth
 * scopes an authorization was granted, the environment ids a Runner enrolled
 * for — against the set it is being replayed with, so a laxer comparison would
 * quietly widen an authorization.
 */
export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
