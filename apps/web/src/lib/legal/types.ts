/**
 * The privacy policy and the terms are data, not markup: one structure per document and language, so that the English and the French texts can be
 * compared by a test (same sections in the same order, the same kinds of block, the same citations of the law).
 *
 * Inline marks inside a string: **bold** and [label](/path), [label](#anchor) or [label](mailto:address). Nothing else is interpreted.
 */
export type Block =
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  /** A two-column list: who or what, then the detail. */
  | { rows: [string, string][] };

export interface LegalSection {
  /** Stable; used as the anchor (#id) and by the tests. The number shown is the position in the list. */
  id: string;
  h: string;
  blocks: Block[];
}

export interface LegalDoc {
  title: string;
  description: string;
  /** Under the title: the version date and the company. */
  meta: string;
  lead: string;
  tocLabel: string;
  sections: LegalSection[];
}

export interface LegalContext {
  /** The published support address (SUPPORT_EMAIL), when the owner has set one. Never invented. */
  supportEmail?: string;
}
