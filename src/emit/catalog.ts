/** 完整目录输出：out/catalog.json（schema: model-catalog/v1）。 */
import { join } from 'node:path';
import { writeJsonAtomic } from '../util/fsx.js';
import type { HostKind, ModelEntry } from '../domain.js';

export interface CatalogDocument {
  schema: 'model-catalog/v1';
  generatedAt: string;
  host: { baseUrl: string; kind: HostKind };
  warnings: string[];
  models: ModelEntry[];
}

export async function writeCatalog(
  dir: string,
  meta: { host: { baseUrl: string; kind: HostKind }; entries: ModelEntry[]; warnings: string[]; generatedAt: string },
): Promise<string> {
  const doc: CatalogDocument = {
    schema: 'model-catalog/v1',
    generatedAt: meta.generatedAt,
    host: meta.host,
    warnings: meta.warnings,
    models: meta.entries,
  };
  const file = join(dir, 'catalog.json');
  await writeJsonAtomic(file, doc);
  return file;
}
