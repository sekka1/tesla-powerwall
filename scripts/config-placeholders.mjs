const PLACEHOLDER_PATTERN = /REPLACE_WITH_[A-Z0-9_]+/g;

/**
 * Finds unfilled placeholder tokens (e.g. `REPLACE_WITH_D1_DATABASE_ID`) in the given text.
 * Used to guard against deploying with a `wrangler.jsonc` that hasn't been configured yet.
 *
 * @param {string} contents
 * @returns {string[]} unique placeholder tokens found, in order of first appearance
 */
export function findPlaceholders(contents) {
  return [...new Set(contents.match(PLACEHOLDER_PATTERN) ?? [])];
}
