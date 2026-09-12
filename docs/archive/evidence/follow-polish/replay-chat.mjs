// Replay the same witnessed activity, then browse its history at a fixed clock.
import { writeFile } from 'node:fs/promises'
import { createLiveSource } from '../../../scripts/lib/live-source.mjs'
import { createReplay } from '../../../scripts/lib/live-view.mjs'
import { stepFollowMotion } from '../../../scripts/lib/follow-motion.mjs'
import { paintLiveView } from '../../../scripts/lib/live-render.mjs'
import { toAnsi, toPlainText } from '../../../scripts/lib/grid.mjs'

const [dimensions, color, output] = process.argv.slice(2)
if (!/^\d+x\d+$/u.test(dimensions ?? '') || !['truecolor', '256', '16'].includes(color) || !output) {
  throw Error('Use: node docs/archive/evidence/follow-polish/replay-chat.mjs 80x24 truecolor output.txt')
}
const [columns, rows] = dimensions.split('x').map(Number)
const size = { columns, rows }
const nowMs = 120000
const source = await createLiveSource({
  mode: 'follow-room', followHandle: 'thog',
  sceneFile: new URL('./follow-polish-scene.json', import.meta.url),
  fetchImpl: async () => { throw Error('Chat replay must never use the network.') },
})
try {
  let shown = (await createReplay(source, size).at(nowMs)).motion
  const plain = []
  const ansi = []
  const capture = key => {
    if (key) shown = stepFollowMotion(shown.state, { nowMs, size, scroll: key })
    const frame = paintLiveView(shown.observation, size, shown.frame)
    const label = `chat ${String(plain.length).padStart(3, '0')} ${key ?? 'newest'} | ${dimensions} | ${nowMs} ms\n`
    plain.push(label + toPlainText(frame))
    ansi.push(label + toAnsi(frame, undefined, color))
  }
  capture()
  capture('home')
  while (shown.frame.activityScroll.offset > 0) capture('down')
  capture('end')
  await writeFile(output, plain.join('\n'), 'utf8')
  await writeFile(`${output}.ansi`, ansi.join('\n'), 'utf8')
  console.log(`Saved ${plain.length} chat frames to ${output}.`)
} finally {
  source.close()
}
