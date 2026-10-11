export interface KeyInfo {
  /** The English singular and plural forms, for keys used with tn(). */
  plural: { one: string; other: string } | null;
  files: string[];
}

export function extractKeys(root?: string): { keys: Map<string, KeyInfo>; problems: string[] };

export function englishCatalog(keys: Map<string, KeyInfo>): Record<string, string | { one: string; other: string }>;
