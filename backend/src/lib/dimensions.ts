import { getJson } from './s3';

export interface DimensionsConfig {
  version?: string;
  scale?: unknown;
  categories: Array<{
    id: string;
    label: string;
    prefix?: string;
    dimensions: Array<{ id: string; statement: string }>;
  }>;
}

let cachedDimensions: DimensionsConfig | null = null;

export async function loadDimensions(): Promise<DimensionsConfig> {
  if (cachedDimensions) return cachedDimensions;
  const config = await getJson<DimensionsConfig>('config/dimensions.json');
  if (!config?.categories) throw new Error('Dimensions config not found in S3');
  cachedDimensions = config;
  return config;
}

export function formatDimensionsBlock(config: DimensionsConfig): string {
  const lines: string[] = [];
  let num = 1;
  for (const cat of config.categories) {
    const prefix = cat.prefix || cat.dimensions[0]?.id.match(/^([a-z]+)_/)?.[1] || '';
    lines.push(`${cat.label} (${prefix}_):`);
    for (const dim of cat.dimensions) {
      lines.push(`${num}. ${dim.id}: ${dim.statement}`);
      num++;
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function totalDimensionCount(config: DimensionsConfig): number {
  return config.categories.reduce((sum, cat) => sum + cat.dimensions.length, 0);
}
