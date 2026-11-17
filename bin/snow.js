#!/usr/bin/env node
import { handleError, main } from '../src/cli.js';

main(process.argv.slice(2)).catch(handleError);
