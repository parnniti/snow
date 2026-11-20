#!/usr/bin/env node
import { handleError, main } from '../src/cli.js';

// `snow ... | head` closes the pipe early; stop quietly instead of crashing with EPIPE.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch(handleError);
