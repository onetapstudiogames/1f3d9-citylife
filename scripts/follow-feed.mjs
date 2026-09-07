#!/usr/bin/env node
import { viewCommand } from './lib/live-view.mjs'
await viewCommand(process.argv.slice(2), { feed: true })
