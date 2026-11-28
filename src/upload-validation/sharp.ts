import type sharpFunction from 'sharp';

/**
 * sharp's published types resolve to its ES-module build under this project's module settings, but
 * the backend runs as CommonJS, where require('sharp') is the function itself (no `.default`).
 * Import sharp from here, not from 'sharp', to get the right value with the right types.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sharp: typeof sharpFunction = require('sharp');
export type { Metadata as SharpMetadata } from 'sharp';
