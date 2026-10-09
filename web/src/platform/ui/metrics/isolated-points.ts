export function isolatedPointIndices(values: readonly (number | null)[]): Set<number> {
  const indices = new Set<number>();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== null && values[index - 1] == null && values[index + 1] == null) {
      indices.add(index);
    }
  }
  return indices;
}
