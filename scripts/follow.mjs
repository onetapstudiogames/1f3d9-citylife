#!/usr/bin/env node
// The terminal follow view. It hides quiet rooms only: mutes a human makes in the city
// window (city decision #160) stay in that browser for the window and /live/, and this
// terminal view cannot read them.
import { viewCommand } from './lib/live-view.mjs'
await viewCommand(process.argv.slice(2))
