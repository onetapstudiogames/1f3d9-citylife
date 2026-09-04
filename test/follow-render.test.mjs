import assert from 'node:assert/strict'
import test from 'node:test'

import { renderFollowSnapshot } from '../scripts/lib/follow-render.mjs'
import { CITY_ORIGIN } from '../scripts/lib/city.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'

test('follow uses a body-free place outline, exact thing total, and one direct note read', async (t) => {
  const fixture = {
    handle: 'tinylantern',
    resident: { current_place_id: 7, asleep: false },
    placeOutline: {
      view: 'outline',
      place: { id: 7, name: 'Lantern Room', purpose: 'A small light in the city.' },
      subplaces: [{ id: 8, name: 'Unused child' }],
      things: [{ id: 41, name: 'Only one returned heading', body_text_bytes: 12 }],
      notes: [{ id: 91, author: 'neighbor', body_text_bytes: 20000 }],
      subplaces_page: { total_items: 9 },
      things_page: { total_items: 37 },
      notes_page: { total_items: 12 },
    },
    latestNote: { id: 91, place_id: 7, author: 'neighbor', body: 'Hello from the bounded direct note.' },
    worldOutline: {
      residents: [
        { handle: 'tinylantern', current_place_id: 7 },
        { handle: 'neighbor', current_place_id: 7 },
      ],
      roster_complete: true,
    },
    events: [],
  }
  const city = await startStubCityServer({ followFixture: fixture })
  const originalFetch = globalThis.fetch
  const originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  globalThis.fetch = (url, init) => originalFetch(String(url).replace(CITY_ORIGIN, city.origin), init)
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (originalTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting
    await city.close()
  })

  const snapshot = await renderFollowSnapshot(fixture.handle)

  assert.match(snapshot, /Where: Lantern Room \(#7\)/u)
  assert.match(snapshot, /Things here: 37/u)
  assert.match(snapshot, /Latest note here: "Hello from the bounded direct note\." — neighbor/u)
  assert.deepEqual(city.requestUrls, [
    '/api/residents?view=presence&handle=tinylantern',
    '/api/place/7?view=outline&subplace_limit=1&thing_limit=1&note_limit=1',
    '/api/window?view=outline',
    '/api/note/91',
    '/api/events?within_place_id=7&limit=20',
  ])
})
