/**
 * Base CLI output formatter
 * Supports both human-readable table format and JSON output
 */

export type OutputFormat = 'table' | 'json';

export interface FormatterOptions {
  format: OutputFormat;
  noColor?: boolean;
}

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * Check if color output should be disabled
 */
function shouldDisableColor(noColor?: boolean): boolean {
  return noColor || process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
}

/**
 * Apply color to text (if colors enabled)
 */
function colorize(text: string, color: keyof typeof colors, noColor?: boolean): string {
  if (shouldDisableColor(noColor)) {
    return text;
  }
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Format data as JSON
 */
export function formatJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format data as a table
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  options?: FormatterOptions
): string {
  if (rows.length === 0) {
    return 'No data to display.';
  }

  const noColor = shouldDisableColor(options?.noColor);

  // Calculate column widths
  const columnWidths = headers.map((header, i) => {
    const maxRowWidth = Math.max(...rows.map((row) => String(row[i] || '').length));
    return Math.max(header.length, maxRowWidth);
  });

  // Format header row
  const headerRow = headers.map((header, i) => header.padEnd(columnWidths[i] || 0)).join('  ');

  const separator = columnWidths.map((width) => '─'.repeat(width)).join('──');

  // Format data rows
  const dataRows = rows.map((row) =>
    row.map((cell, i) => String(cell || '-').padEnd(columnWidths[i] || 0)).join('  ')
  );

  // Combine all parts
  const parts = [
    colorize(headerRow, 'bold', noColor),
    colorize(separator, 'dim', noColor),
    ...dataRows,
  ];

  return parts.join('\n');
}

/**
 * Format output based on options
 */
export function formatOutput(
  data: unknown,
  options: FormatterOptions,
  tableFormatter?: (data: unknown, options?: FormatterOptions) => string
): string {
  if (options.format === 'json') {
    return formatJSON(data);
  }

  if (tableFormatter) {
    return tableFormatter(data, options);
  }

  // Fallback to JSON if no table formatter provided
  return formatJSON(data);
}

/**
 * Format error for CLI output
 */
export function formatError(error: Error, options?: FormatterOptions): string {
  const noColor = shouldDisableColor(options?.noColor);

  if (options?.format === 'json') {
    return formatJSON({
      error: error.message,
      name: error.name,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }

  const errorLabel = colorize('Error:', 'red', noColor);
  const errorMessage = error.message;

  let output = `${errorLabel} ${errorMessage}`;

  if (process.env.NODE_ENV === 'development' && error.stack) {
    output += `\n\n${colorize('Stack trace:', 'dim', noColor)}\n${error.stack}`;
  }

  return output;
}

/**
 * Format success message
 */
export function formatSuccess(message: string, options?: FormatterOptions): string {
  const noColor = shouldDisableColor(options?.noColor);

  if (options?.format === 'json') {
    return formatJSON({ success: true, message });
  }

  const checkmark = colorize('✓', 'green', noColor);
  return `${checkmark} ${message}`;
}

/**
 * Format warning message
 */
export function formatWarning(message: string, options?: FormatterOptions): string {
  const noColor = shouldDisableColor(options?.noColor);

  if (options?.format === 'json') {
    return formatJSON({ warning: true, message });
  }

  const warningLabel = colorize('⚠', 'yellow', noColor);
  return `${warningLabel} ${message}`;
}

/**
 * Format info message
 */
export function formatInfo(message: string, options?: FormatterOptions): string {
  const noColor = shouldDisableColor(options?.noColor);

  if (options?.format === 'json') {
    return formatJSON({ info: true, message });
  }

  const infoLabel = colorize('ℹ', 'blue', noColor);
  return `${infoLabel} ${message}`;
}

/**
 * Print to stdout
 */
export function print(message: string): void {
  process.stdout.write(message + '\n');
}

/**
 * Print to stderr
 */
export function printError(message: string): void {
  process.stderr.write(message + '\n');
}

/**
 * Exit with code and optional message
 */
export function exit(code: number, message?: string): never {
  if (message) {
    if (code === 0) {
      print(message);
    } else {
      printError(message);
    }
  }
  process.exit(code);
}
