#!/usr/bin/env bun

import { createDefaultCliDependencies, runCli } from "./cli.js";

const invokedPath = process.argv0;
const arguments_ = process.argv.slice(2);

try {
  process.exitCode = await runCli(
    invokedPath,
    arguments_,
    createDefaultCliDependencies(),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
