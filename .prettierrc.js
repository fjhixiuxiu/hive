'use strict';

/**
 * Formatting, so that nobody has to think about it again.
 *
 * These values are not a preference — they are a description of the 34,000
 * lines hive was already written in, measured rather than chosen. 43 of the 44
 * files under src/ indent with two spaces, every destructure in the codebase is
 * written `{ TaskStatus }`, and the quote and semicolon style has been uniform
 * since the first commit. Writing that down means the one-time reformat is a
 * reformat and not a rewrite, and it means the diff on every future PR is the
 * change itself rather than the change plus whichever editor touched the file.
 *
 * The previous version of this file said `tabWidth: 4` and
 * `bracketSpacing: false`, which describes a codebase this is not. Nothing ran
 * it — prettier was never a dependency — so the mismatch was invisible and
 * free. It stops being free the moment the formatter is real: honouring it
 * would have reindented all of src/ and stripped the brace spacing out of
 * every import in the repo. It is corrected here to match what is on disk.
 */
module.exports = {
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
};
