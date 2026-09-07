import { sanitizeBubbleText } from './bubble-text.mjs'

const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
const safe = value => sanitizeBubbleText(value)
const lookup = (entries, value) => new Map(entries ?? []).get(String(value)) ?? null
const thingIdFor = d => id(d.thing_id) ?? id(d.source_thing_id)
  ?? (d.asset_type === 'thing' ? id(d.asset_id) : null) ?? (d.type === 'thing' ? id(d.id) : null)
const basic = Object.freeze({ talk: 'talked', move: 'moved', go_home: 'went home', give: 'gave', use: 'used', consume: 'consumed', make: 'made' })

// These are public record descriptions, not guesses about a resident's intentions.
const kinds = Object.freeze({
  register: ['moved into the city', 'arrival'], rotate: ['rotated their key', 'change'],
  resident_edited: ['changed their drawing', 'change'], home_set: ['set their home', 'home'],
  place_created: ['founded', 'make'], place_edited: ['changed', 'change'],
  place_renamed: ['renamed', 'change'], place_retired: ['retired', 'change'], place_restored: ['restored', 'change'],
  kind_invented: ['invented', 'make'], kind_revised: ['revised', 'change'], trait_coined: ['coined', 'make'],
  thing_created: ['created', 'make'], thing_crafted: ['crafted', 'make'], thing_edited: ['changed', 'change'],
  thing_moved: ['moved', 'action'], thing_upgraded: ['upgraded', 'change'], thing_withdrawn: ['withdrew', 'change'],
  laws_changed: ['changed the local laws', 'rules'], effect_scheduled: ['scheduled an effect', 'wait'],
  effect_resolved: ['resolved an effect', 'effect'], gazette_printed: ['printed The Gazette', 'make'],
  agreement: ['wrote an agreement', 'agreement'], agreement_accession: ['opened an agreement to later signers', 'agreement'],
  agreement_sign: ['signed an agreement', 'agreement'], transfer: ['transferred', 'trade'],
  transfer_offer: ['offered for sale', 'trade'], sale: ['bought', 'trade'], transfer_cancel: ['canceled a sale offer', 'trade'],
  world_listed: ['listed on the world market', 'trade'], world_sale: ['bought through the world market', 'trade'],
  world_cancel: ['canceled a world market listing', 'trade'], payment_repair: ['recorded a payment correction', 'change'],
  flag: ['flagged a public record', 'rules'], moderation: ['changed moderation of a public record', 'rules'],
})

const linkKeys = d => [
  ['effect', d.effect_id ?? d.pending_effect_id], ['offer', d.offer_id ?? d.transfer_id], ['agreement', d.agreement_id],
].filter(([, value]) => id(value) !== null).map(([type, value]) => `${type}:${value}`)

/** Remember only public entity locations and relationships that this camera has seen. */
export const extendEventContext = (known, previous, observation, roomId) => {
  if (!observation) return { ...known, residentRooms: previous?.residentRooms ?? [], kinds: previous?.kinds ?? [], links: previous?.links ?? [], noteRooms: previous?.noteRooms ?? [] }
  const residentRooms = (observation.rooms ?? []).flatMap(room => (room.residents ?? []).map(resident =>
    [String(resident.id), room.id]))
  const kindRooms = (observation.rooms ?? []).flatMap(room => (room.things ?? []).filter(thing => id(thing.kind_id) !== null)
    .map(thing => [String(thing.kind_id), room.id]))
  const links = new Map(previous?.links ?? [])
  const things = new Map(known.things)
  const noteRooms = new Map(previous?.noteRooms ?? [])
  for (const note of observation.notes ?? []) {
    if (id(note.id) && id(note.place_id)) noteRooms.set(String(note.id), id(note.place_id))
  }
  for (const row of observation.contextEvents ?? observation.events ?? []) {
    const d = row.detail ?? {}
    // A room-scoped schedule provides the only public location for its later resolution.
    if (['effect_scheduled', 'transfer_offer', 'world_listed', 'agreement'].includes(row.kind)
      && roomFor(row, { ...known, residentRooms, kinds: kindRooms, links: [...links] }, roomId) === roomId) {
      for (const key of linkKeys(d)) links.set(key, { roomId, thingId: thingIdFor(d) })
    }
    const thingId = thingIdFor(d)
    if (row.kind === 'thing_moved' && thingId !== null && id(d.place_id) !== null) {
      const held = things.get(String(thingId))
      if (held) things.set(String(thingId), { ...held, roomId: id(d.place_id) })
    }
  }
  return { ...known, things: [...things], residentRooms, kinds: kindRooms, links: [...links].slice(-200), noteRooms: [...noteRooms].slice(-200) }
}

const roomFor = (row, known, roomId) => {
  const d = row.detail ?? {}
  const explicit = [d.place_id, d.from_place_id, d.to_place_id].map(id).filter(value => value !== null)
  if (explicit.length) return explicit.includes(roomId) || (row.kind === 'place_created' && id(d.parent_id) === roomId) ? roomId : null
  if (row.kind === 'resident_edited') return lookup(known.residentRooms, id(d.resident_id)) === roomId ? roomId : null
  const related = linkKeys(d).map(key => lookup(known.links, key)).find(value => value?.roomId === roomId)
  if (related) return roomId
  const thing = lookup(known.things, thingIdFor(d))
  if (thing?.roomId === roomId) return roomId
  if (id(d.kind_id) !== null && lookup(known.kinds, d.kind_id) === roomId) return roomId
  const assetType = d.asset_type ?? d.type ?? d.target_type
  const assetId = id(d.asset_id) ?? id(d.id) ?? id(d.target_id)
  if (assetType === 'place' && assetId === roomId) return roomId
  if (assetType === 'thing' && lookup(known.things, assetId)?.roomId === roomId) return roomId
  if (assetType === 'note' && lookup(known.noteRooms, assetId) === roomId) return roomId
  if (assetType === 'resident' && lookup(known.residentRooms, assetId) === roomId) return roomId
  return null
}

const pairedCarry = (row, rows) => rows.some(notice => notice.kind === 'thing_moved' && notice.actor === row.actor
  && notice.detail?.mode === 'carry' && id(notice.detail?.action_id) !== null
  && id(notice.detail.action_id) === id(row.detail?.action_id)
  && id(notice.detail.thing_id) === id(row.detail.thing_id)
  && id(notice.detail.from_place_id) === id(row.detail.from_place_id)
  && id(notice.detail.place_id) === id(row.detail.to_place_id))

const actionDescription = (row, known, roomId, rows) => {
  const d = row.detail ?? {}
  if (!Object.hasOwn(basic, d.action) || !['applied', 'noop', 'blocked', 'failed', 'refused'].includes(d.status)) return null
  const thingId = thingIdFor(d)
  const thing = lookup(known.things, thingId)?.name ?? (thingId ? `thing #${thingId}` : '')
  const error = safe(d.error)
  if (['blocked', 'failed', 'refused'].includes(d.status)) return {
    description: `tried to ${d.action === 'go_home' ? 'go home' : d.action}${thing ? ` ${thing}` : ''}; ${d.status}${error ? `: ${error}` : ''}`,
    cue: 'attempt', thingId,
  }
  if (d.error !== undefined && d.error !== null) return null
  const suffix = d.status === 'noop' ? '; no change' : ''
  if (['move', 'go_home'].includes(d.action)) {
    if (id(d.from_place_id) === null || id(d.to_place_id) === null) return null
    const destination = lookup(known.places, d.to_place_id) ?? `place #${d.to_place_id}`
    const carry = d.mode === 'carry' && pairedCarry(row, rows) && thing
    return { description: `${carry ? `carried ${thing} to` : d.action === 'go_home' ? 'went home to' : 'moved to'} ${destination}${suffix}`,
      cue: id(d.to_place_id) === roomId ? 'arrival' : 'departure', thingId }
  }
  if (d.action === 'talk' && rows.some(other => other.kind === 'note' && other.actor === row.actor && id(other.detail?.action_id) === id(d.action_id) && id(d.action_id) !== null)) return null
  return { description: `${basic[d.action]}${thing ? ` ${thing}` : ''}${suffix}`, cue: d.status === 'noop' ? 'action' : d.action === 'make' ? 'make' : 'action', thingId }
}

/** One description and cue for a witnessed public event; unknown/private facts stay absent. */
export const describeRoomEvent = (row, known, roomId, rows) => {
  const d = row?.detail ?? {}
  const actor = safe(row?.actor)
  if (!actor || roomFor(row, known, roomId) === null) return null
  let detail
  if (row.kind === 'action') detail = actionDescription(row, known, roomId, rows)
  else if (Object.hasOwn(kinds, row.kind)) {
    if (row.kind !== 'effect_resolved' && d.error !== undefined && d.error !== null) return null
    let [description, cue] = kinds[row.kind]
    const related = linkKeys(d).map(key => lookup(known.links, key)).find(value => value?.roomId === roomId)
    const thingId = thingIdFor(d) ?? related?.thingId ?? null
    const thing = lookup(known.things, thingId)?.name ?? (thingId ? `thing #${thingId}` : '')
    const assetType = d.asset_type ?? d.type
    const asset = thing || (assetType ? `${assetType} #${id(d.asset_id) ?? id(d.id)}` : 'property')
    if (row.kind.startsWith('thing_')) {
      if (!thingId) return null
      if (row.kind === 'thing_moved' && d.mode === 'carry' && rows.some(action => action.kind === 'action' && action.actor === row.actor
        && action.detail?.status === 'applied' && action.detail?.action === 'move' && pairedCarry(action, [row]))) return null
      description += ` ${thing}`
      if (row.kind === 'thing_moved') description += id(d.place_id) === roomId ? ' into the room' : ' out of the room'
    } else if (row.kind.startsWith('place_')) description += ` ${safe(d.name) || lookup(known.places, d.place_id) || `place #${d.place_id}`}`
    else if (row.kind.startsWith('kind_')) description += ` ${safe(d.name) || `kind #${d.kind_id}`}`
    else if (row.kind === 'trait_coined') description += ` ${safe(d.name) || `trait #${d.trait_id}`}`
    else if (row.kind === 'transfer') {
      const recipient = lookup(known.residents, id(d.resident_id)) ?? (id(d.resident_id) ? `resident #${d.resident_id}` : '')
      description = `${d.mode === 'gift' ? 'gave' : 'transferred'} ${asset}${recipient ? ` to ${recipient}` : ''}`
    } else if (['transfer_offer', 'sale', 'world_listed', 'world_sale'].includes(row.kind)) description += ` ${asset}`
    else if (['effect_resolved', 'effect_scheduled'].includes(row.kind)) {
      if (row.kind === 'effect_resolved') {
        if (!['applied', 'skipped', 'failed'].includes(d.status)) return null
        description = `had a scheduled effect ${d.status === 'applied' ? 'take effect' : d.status === 'skipped' ? 'be skipped' : 'fail'}`
        cue = d.status === 'applied' ? 'effect' : 'attempt'
      }
      if (thing) description += ` involving ${thing}`
      if (safe(d.error)) description += `: ${safe(d.error)}`
    } else if (row.kind === 'gazette_printed' && id(d.issue_number)) description += ` issue ${d.issue_number}`
    detail = { description, cue, thingId }
  }
  if (!detail) return null
  return { text: `${actor} ${detail.description}.`, actor, cue: detail.cue, thingId: detail.thingId,
    residentId: row.kind === 'resident_edited' ? id(d.resident_id) : null, eventId: id(row.id), roomId }
}
