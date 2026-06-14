export interface ResolvePublishLabelsOptions {
  currentLabels?: string[];
  explicitLabels?: string[];
}

export function resolvePublishLabels(options: ResolvePublishLabelsOptions = {}): string[] | undefined {
  const merged: string[] = [];

  const append = (labels?: string[]) => {
    if (!labels) return;
    for (const label of labels) {
      if (!label || merged.includes(label)) continue;
      merged.push(label);
    }
  };

  append(options.currentLabels);
  append(options.explicitLabels);

  return merged.length > 0 ? merged : undefined;
}
