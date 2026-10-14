#!/usr/bin/env node
import { main } from './main.ts'

void main(process.argv.slice(2)).then((out) => {
  process.stdout.write(out.stdout)
  process.exitCode = out.exitCode
})
