// The bold face of each bundled family as a data URI, for the counts drawn in the marker images of the Galaxy Map. An SVG drawn as an image cannot use the faces the page loaded, so the face travels inside the image. Loaded when a count is drawn, as a chunk of its own; a family that is not bundled has none and is found by its name.
const FACES = {
  roboto: () => import('roboto-fontface/fonts/roboto/Roboto-Bold.woff2?inline'),
  'roboto-condensed': () => import('roboto-fontface/fonts/roboto-condensed/Roboto-Condensed-Bold.woff2?inline'),
}

// The data URI of the bold face of the family `id`, or null for a family with none or a face that did not load.
export const glyphFace = async (id) => {
  const load = Object.prototype.hasOwnProperty.call(FACES, id) ? FACES[id] : null

  if (!load) {
    return null
  }

  try {
    return (await load()).default
  } catch (error) {
    return null
  }
}
