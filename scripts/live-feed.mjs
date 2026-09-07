#!/usr/bin/env node
import { viewCommand } from './lib/live-view.mjs'
await viewCommand('live', process.argv.slice(2), { feed: true })
